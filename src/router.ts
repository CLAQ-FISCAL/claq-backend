import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { Prisma, PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import { audit } from './lib/audit';
import { NUIT_RE, maskNuit } from './lib/crypto';
import { AppError, errorResponse, header, jsonResponse, parseJsonBody, optionalString, requireString, type ApiResponse } from './lib/http';
import { ensureUser, resolveTenant, withTenant } from './lib/tenant';
import { assertNotificationChannel, assertSimulatorAccess, enforceCompanyLimit, getPlanLimits } from './lib/plans';
import { dashboardSummary, toDto } from './domain/dashboard';
import { generateObligations, validateStatusTransition } from './domain/obligations';
import { getApprovedRule } from './rules';
import { parseInputs, runSimulator } from './simulators/engine';
import { getSimulator, simulators } from './simulators/definitions';

const OBLIGATION_STATUSES = ['UPCOMING', 'DUE', 'OVERDUE', 'PAID', 'SUBMITTED', 'NOT_APPLICABLE'] as const;
const CHANNELS = ['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP'] as const;

export type CryptoDeps = {
  sealValue: (plaintext: string) => Promise<Buffer>;
  openValue: (ciphertext: Buffer) => Promise<string>;
};

type RouteParams = Record<string, string>;

type RequestContext = {
  db: PrismaClient;
  crypto: CryptoDeps;
  requestId: string;
  userId: string;
  tenantId: string;
  role: string;
  plan: string;
  query: Record<string, string | undefined>;
  body: Record<string, unknown>;
  /** Run inside a transaction with the RLS tenant context applied. */
  run: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
};

type Route = { method: string; pattern: RegExp; status?: number; handler: (ctx: RequestContext, params: RouteParams) => Promise<object> };

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(422, 'INPUT_INVALID', `Query parameter '${field}' must be an ISO date.`);
  return date;
}

function parseMonth(value: string | undefined): { start: Date; end: Date } {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) throw new AppError(422, 'INPUT_INVALID', "Query parameter 'month' must look like YYYY-MM.");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) throw new AppError(422, 'INPUT_INVALID', "Query parameter 'month' must be between 01 and 12.");
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

function jsonInputs(inputs: Record<string, Decimal | string>): Record<string, string> {
  return Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, typeof v === 'string' ? v : v.toFixed(2)]));
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/me$/,
    handler: async (ctx) => {
      const memberships = await ctx.db.membership.findMany({
        where: { userId: ctx.userId },
        include: { tenant: { select: { id: true, name: true, plan: true } } },
        orderBy: { tenant: { name: 'asc' } },
      });
      const user = await ctx.db.user.findUnique({ where: { id: ctx.userId }, select: { id: true, email: true, displayName: true } });
      return { user, tenants: memberships.map((m) => ({ ...m.tenant, role: m.role })) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/subscription$/,
    handler: async (ctx) => {
      const tenant = await ctx.db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { plan: true } });
      if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found.');
      const limits = getPlanLimits(tenant.plan);
      const [companyCount, userCount] = await Promise.all([
        ctx.db.company.count({ where: { tenantId: ctx.tenantId } }),
        ctx.db.membership.count({ where: { tenantId: ctx.tenantId } }),
      ]);
      return {
        plan: tenant.plan,
        label: limits.label,
        limits: {
          maxCompanies: limits.maxCompanies === Infinity ? null : limits.maxCompanies,
          maxUsers: limits.maxUsers === Infinity ? null : limits.maxUsers,
          simulatorAccess: limits.simulatorAccess,
          notificationChannels: limits.notificationChannels,
          maxLeadDaysEntries: limits.maxLeadDaysEntries,
        },
        usage: { companies: companyCount, users: userCount },
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/dashboard$/,
    handler: async (ctx) => {
      const tenant = await ctx.db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { id: true, name: true, plan: true } });
      if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant no longer exists.');
      return ctx.run((tx) => dashboardSummary(tx, tenant, new Date()));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/obligations$/,
    handler: async (ctx) => {
      const statuses = (ctx.query.status ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const status of statuses) {
        if (!(OBLIGATION_STATUSES as readonly string[]).includes(status)) throw new AppError(422, 'INPUT_INVALID', `Unknown status '${status}'.`);
      }
      const limitRaw = Number(ctx.query.limit ?? 100);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 500) throw new AppError(422, 'INPUT_INVALID', "'limit' must be an integer between 1 and 500.");
      const offsetRaw = Number(ctx.query.offset ?? 0);
      if (!Number.isInteger(offsetRaw) || offsetRaw < 0) throw new AppError(422, 'INPUT_INVALID', "'offset' must be a non-negative integer.");
      return ctx.run(async (tx) => {
        const where: Prisma.ObligationWhereInput = {
          tenantId: ctx.tenantId,
          ...(statuses.length > 0 ? { status: { in: statuses as (typeof OBLIGATION_STATUSES)[number][] } } : {}),
          ...(ctx.query.companyId ? { companyId: ctx.query.companyId } : {}),
          ...(ctx.query.from || ctx.query.to ? { dueAt: { ...(ctx.query.from ? { gte: parseDate(ctx.query.from, 'from')! } : {}), ...(ctx.query.to ? { lte: parseDate(ctx.query.to, 'to')! } : {}) } } : {}),
        };
        const [items, total] = await Promise.all([
          tx.obligation.findMany({ where, orderBy: [{ dueAt: 'asc' }, { title: 'asc' }], take: limitRaw, skip: offsetRaw, include: { company: { select: { legalName: true } } } }),
          tx.obligation.count({ where }),
        ]);
        return { items: items.map(toDto), total, limit: limitRaw, offset: offsetRaw };
      });
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/obligations\/(?<id>[\w-]+)$/,
    handler: async (ctx, params) => {
      const to = requireString(ctx.body, 'status', 40);
      if (!(OBLIGATION_STATUSES as readonly string[]).includes(to)) throw new AppError(422, 'INPUT_INVALID', `Unknown status '${to}'.`);
      const status = to as (typeof OBLIGATION_STATUSES)[number];
      return ctx.run(async (tx) => {
        const existing = await tx.obligation.findFirst({ where: { id: params.id, tenantId: ctx.tenantId } });
        if (!existing) throw new AppError(404, 'NOT_FOUND', 'Obligation not found.');
        validateStatusTransition(existing.status, status);
        const updated = await tx.obligation.update({ where: { id: existing.id }, data: { status }, include: { company: { select: { legalName: true } } } });
        await audit(tx, {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'OBLIGATION_STATUS_CHANGED',
          entityType: 'Obligation',
          entityId: existing.id,
          requestId: ctx.requestId,
          before: { status: existing.status },
          after: { status },
        });
        return toDto(updated);
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/obligations\/generate$/,
    status: 201,
    handler: async (ctx) => {
      const companyId = requireString(ctx.body, 'companyId', 64);
      const year = ctx.body.year;
      if (typeof year !== 'number' || !Number.isInteger(year)) throw new AppError(422, 'INPUT_INVALID', "Field 'year' must be an integer.");
      return ctx.run((tx) => generateObligations(tx, { tenantId: ctx.tenantId, companyId, actorId: ctx.userId, requestId: ctx.requestId, year }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/calendar$/,
    handler: async (ctx) => {
      const { start, end } = parseMonth(ctx.query.month);
      return ctx.run(async (tx) => {
        const items = await tx.obligation.findMany({
          where: { tenantId: ctx.tenantId, dueAt: { gte: start, lt: end } },
          orderBy: { dueAt: 'asc' },
          include: { company: { select: { legalName: true } } },
        });
        const days: Record<string, ObligationDayItem[]> = {};
        for (const item of items) {
          const day = item.dueAt.toISOString().slice(0, 10);
          (days[day] ??= []).push({ id: item.id, title: item.title, status: item.status, companyId: item.companyId, companyLegalName: item.company.legalName });
        }
        return { month: ctx.query.month, days };
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/companies$/,
    handler: async (ctx) =>
      ctx.run(async (tx) => {
        const companies = await tx.company.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { legalName: 'asc' } });
        return { items: companies.map((c) => ({ id: c.id, legalName: c.legalName, hasNuit: c.nuitCiphertext !== null, municipality: c.municipality, taxRegime: c.taxRegime })) };
      }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/companies$/,
    status: 201,
    handler: async (ctx) => {
      const legalName = requireString(ctx.body, 'legalName', 200);
      const nuit = optionalString(ctx.body, 'nuit', 9);
      if (nuit !== undefined && !NUIT_RE.test(nuit)) throw new AppError(422, 'INPUT_INVALID', 'NUIT must be exactly 9 digits.');
      const municipality = optionalString(ctx.body, 'municipality', 100);
      const taxRegime = optionalString(ctx.body, 'taxRegime', 50);
      return ctx.run(async (tx) => {
        await enforceCompanyLimit(tx, ctx.tenantId, ctx.plan);
        const company = await tx.company.create({
          data: {
            tenantId: ctx.tenantId,
            legalName,
            nuitCiphertext: nuit ? new Uint8Array(await ctx.crypto.sealValue(nuit)) : null,
            municipality,
            taxRegime,
          },
        });
        await audit(tx, {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'COMPANY_CREATED',
          entityType: 'Company',
          entityId: company.id,
          requestId: ctx.requestId,
          after: { legalName, nuit: nuit ? maskNuit(nuit) : null, municipality, taxRegime },
        });
        return { id: company.id, legalName: company.legalName, hasNuit: nuit !== undefined, municipality, taxRegime };
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/companies\/(?<id>[\w-]+)$/,
    handler: async (ctx, params) => {
      const reveal = ctx.query.revealNuit === 'true';
      return ctx.run(async (tx) => {
        const company = await tx.company.findFirst({ where: { id: params.id, tenantId: ctx.tenantId } });
        if (!company) throw new AppError(404, 'NOT_FOUND', 'Company not found.');
        if (!reveal || !company.nuitCiphertext) {
          return { id: company.id, legalName: company.legalName, hasNuit: company.nuitCiphertext !== null, municipality: company.municipality, taxRegime: company.taxRegime };
        }
        const nuit = await ctx.crypto.openValue(Buffer.from(company.nuitCiphertext));
        await audit(tx, {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'NUIT_REVEALED',
          entityType: 'Company',
          entityId: company.id,
          requestId: ctx.requestId,
        });
        return { id: company.id, legalName: company.legalName, nuit, hasNuit: true, municipality: company.municipality, taxRegime: company.taxRegime };
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/simulators$/,
    handler: async () => ({
      items: simulators.map((s) => ({ code: s.code, title: s.title, category: s.category, description: s.description, inputs: s.inputs, ruleCodes: s.ruleCodes })),
    }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/simulators\/(?<code>[\w-]+)$/,
    status: 201,
    handler: async (ctx, params) => {
      const sim = getSimulator(params.code);
      if (!sim) throw new AppError(404, 'SIMULATOR_NOT_FOUND', `Unknown simulator '${params.code}'.`);
      const rawInputs = typeof ctx.body.inputs === 'object' && ctx.body.inputs !== null ? (ctx.body.inputs as Record<string, unknown>) : {};
      const inputs = parseInputs(sim, rawInputs);
      const at = parseDate(typeof ctx.body.at === 'string' ? ctx.body.at : undefined, 'at') ?? new Date();
      const companyId = optionalString(ctx.body, 'companyId', 64);
      assertSimulatorAccess(ctx.plan, sim.code);
      return ctx.run(async (tx) => {
        if (companyId) {
          const company = await tx.company.findFirst({ where: { id: companyId, tenantId: ctx.tenantId }, select: { id: true } });
          if (!company) throw new AppError(404, 'COMPANY_NOT_FOUND', 'Company not found in this tenant.');
        }
        const result = await runSimulator(sim, inputs, (code) => getApprovedRule(tx, code, at));
        const saved = await tx.simulation.create({
          data: {
            tenantId: ctx.tenantId,
            companyId: companyId ?? null,
            code: sim.code,
            inputs: jsonInputs(inputs),
            breakdown: result.lines,
            total: result.total,
            ruleVersions: result.ruleVersions,
          },
        });
        return { id: saved.id, code: sim.code, title: sim.title, category: sim.category, at: at.toISOString(), inputs: jsonInputs(inputs), lines: result.lines, total: result.total, ruleVersions: result.ruleVersions };
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/simulations$/,
    handler: async (ctx) => {
      const limitRaw = Number(ctx.query.limit ?? 50);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) throw new AppError(422, 'INPUT_INVALID', "'limit' must be an integer between 1 and 200.");
      return ctx.run(async (tx) => {
        const items = await tx.simulation.findMany({
          where: { tenantId: ctx.tenantId, ...(ctx.query.code ? { code: ctx.query.code } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limitRaw,
          select: { id: true, code: true, inputs: true, total: true, ruleVersions: true, createdAt: true, companyId: true },
        });
        return { items };
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/rules\/(?<code>[\w-]+)$/,
    handler: async (ctx, params) =>
      ctx.run(async (tx) => {
        const rule = await tx.ruleSet.findFirst({ where: { code: params.code }, orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }] });
        if (!rule) throw new AppError(404, 'NOT_FOUND', `No rule exists for code '${params.code}'.`);
        const now = new Date();
        const approvedNow = rule.status === 'APPROVED' && rule.effectiveFrom <= now && (rule.effectiveTo === null || rule.effectiveTo >= now);
        return {
          code: rule.code,
          version: rule.version,
          status: rule.status,
          effectiveFrom: rule.effectiveFrom.toISOString(),
          effectiveTo: rule.effectiveTo?.toISOString() ?? null,
          sourceUrl: rule.sourceUrl,
          reviewer: rule.reviewer,
          approvedAt: rule.approvedAt?.toISOString() ?? null,
          approvedNow,
          content: rule.content,
        };
      }),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/notification-settings$/,
    handler: async (ctx) =>
      ctx.run(async (tx) => {
        const settings = await tx.notificationSetting.findMany({ where: { tenantId: ctx.tenantId } });
        return { items: CHANNELS.map((channel) => {
          const found = settings.find((s) => s.channel === channel);
          return { channel, enabled: found?.enabled ?? false, leadDays: found?.leadDays ?? [] };
        }) };
      }),
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/notification-settings\/(?<channel>[\w-]+)$/,
    handler: async (ctx, params) => {
      const channel = params.channel.toUpperCase();
      if (!(CHANNELS as readonly string[]).includes(channel)) throw new AppError(404, 'NOT_FOUND', `Unknown channel '${params.channel}'.`);
      assertNotificationChannel(ctx.plan, channel);
      const enabled = ctx.body.enabled;
      if (enabled !== undefined && typeof enabled !== 'boolean') throw new AppError(422, 'INPUT_INVALID', "Field 'enabled' must be a boolean.");
      const leadDaysRaw = ctx.body.leadDays;
      let leadDays: number[] | undefined;
      if (leadDaysRaw !== undefined) {
        if (!Array.isArray(leadDaysRaw) || leadDaysRaw.length === 0 || leadDaysRaw.length > 8) throw new AppError(422, 'INPUT_INVALID', "Field 'leadDays' must be an array of 1-8 integers.");
        leadDays = [...new Set(leadDaysRaw)].map((d) => {
          if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 30) throw new AppError(422, 'INPUT_INVALID', 'leadDays entries must be integers between 0 and 30.');
          return d;
        }).sort((a, b) => b - a);
      }
      return ctx.run(async (tx) => {
        const setting = await tx.notificationSetting.upsert({
          where: { tenantId_channel: { tenantId: ctx.tenantId, channel: channel as (typeof CHANNELS)[number] } },
          update: { ...(enabled !== undefined ? { enabled } : {}), ...(leadDays !== undefined ? { leadDays } : {}) },
          create: { tenantId: ctx.tenantId, channel: channel as (typeof CHANNELS)[number], enabled: enabled ?? false, leadDays: leadDays ?? [7, 3, 1, 0] },
        });
        await audit(tx, {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'NOTIFICATION_SETTINGS_UPDATED',
          entityType: 'NotificationSetting',
          entityId: setting.id,
          requestId: ctx.requestId,
          after: { channel, enabled: setting.enabled, leadDays: setting.leadDays },
        });
        return { channel: setting.channel, enabled: setting.enabled, leadDays: setting.leadDays };
      });
    },
  },
  // ---------- Billing ----------
  {
    method: 'GET',
    pattern: /^\/v1\/billing\/subscription$/,
    handler: async (ctx) => {
      const tenant = await ctx.db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { stripeCustomerId: true } });
      if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found.');
      const sub = await ctx.db.billingSubscription.findFirst({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' } });
      return {
        hasStripeCustomer: tenant.stripeCustomerId !== null,
        subscription: sub
          ? { status: sub.status, priceId: sub.priceId, currentPeriodStart: sub.currentPeriodStart.toISOString(), currentPeriodEnd: sub.currentPeriodEnd.toISOString(), cancelAtPeriodEnd: sub.cancelAtPeriodEnd }
          : null,
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/billing\/invoices$/,
    handler: async (ctx) => {
      const limitRaw = Number(ctx.query.limit ?? 20);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) throw new AppError(422, 'INPUT_INVALID', "'limit' must be an integer between 1 and 100.");
      const items = await ctx.db.invoice.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' }, take: limitRaw });
      return { items: items.map((i) => ({ id: i.id, stripeInvoiceId: i.stripeInvoiceId, amountDue: i.amountDue, currency: i.currency, status: i.status, hostedInvoiceUrl: i.hostedInvoiceUrl, createdAt: i.createdAt.toISOString() })) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/billing\/webhook$/,
    status: 200,
    handler: async (ctx) => {
      const stripeSignature = (ctx as unknown as { rawHeaders?: Record<string, string> }).rawHeaders?.['stripe-signature'] ?? '';
      if (!stripeSignature) throw new AppError(400, 'MISSING_SIGNATURE', 'Missing Stripe signature header.');
      const { handleStripeWebhook } = await import('./billing/webhook.js');
      const rawBody = (ctx as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(ctx.body);
      const result = await handleStripeWebhook(rawBody, stripeSignature);
      return { received: true, message: result.message };
    },
  },
];

type ObligationDayItem = { id: string; title: string; status: string; companyId: string; companyLegalName: string };

export function createHandler(db: PrismaClient, crypto: CryptoDeps): (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<ApiResponse> {
  return async (event) => {
    const requestId = event.requestContext.requestId || randomUUID();
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    try {
      if (path === '/v1/health') {
        try {
          await db.$queryRaw`SELECT 1`;
          return jsonResponse(200, { status: 'ok', environment: process.env.APP_ENV, requestId }, requestId);
        } catch {
          return jsonResponse(503, { status: 'degraded', environment: process.env.APP_ENV, requestId }, requestId);
        }
      }

      const claims = (event.requestContext.authorizer?.jwt.claims ?? {}) as Record<string, unknown>;
      const user = await ensureUser(db, claims);
      const tenant = await resolveTenant(db, user.id, header(event, 'x-tenant-id'));

      const ctx: RequestContext = {
        db,
        crypto,
        requestId,
        userId: user.id,
        tenantId: tenant.tenantId,
        role: tenant.role,
        plan: tenant.plan,
        query: event.queryStringParameters ?? {},
        body: parseJsonBody(event.body),
        run: (fn) => withTenant(db, tenant.tenantId, fn),
      };

      for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.pattern.exec(path);
        if (!match) continue;
        const body = await route.handler(ctx, match.groups ?? {});
        return jsonResponse(route.status ?? 200, body, requestId);
      }
      return jsonResponse(404, { code: 'NOT_FOUND', message: `No route for ${method} ${path}`, requestId }, requestId);
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
