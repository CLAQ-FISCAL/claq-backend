import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { PrismaClient } from '@prisma/client';
import { createHandler, type CryptoDeps } from '../src/router';

const crypto: CryptoDeps = {
  sealValue: async (v) => Buffer.from(v),
  openValue: async (b) => b.toString('utf8'),
};

type PlanDto = {
  code: string;
  label: string;
  family: string;
  description?: string;
  priceMzn?: number | null;
  limits: {
    maxCompanies: number;
    maxUsers: number;
    storageLimitBytes: number;
    features: string[];
    simulatorAccess: string[];
    notificationChannels: string[];
    maxLeadDaysEntries: number;
    annualRevenueMaxMzn: number | null;
  };
};

function event(method: string, path: string, opts: { claims?: Record<string, unknown>; headers?: Record<string, string>; query?: Record<string, string> } = {}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    rawPath: path,
    headers: opts.headers ?? {},
    queryStringParameters: opts.query ?? null,
    body: undefined,
    isBase64Encoded: false,
    version: '2.0',
    routeKey: `${method} ${path}`,
    requestContext: {
      requestId: 'req-1',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      accountId: '1',
      apiId: 'api',
      domainName: 'api.example',
      domainPrefix: 'api',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer: { jwt: { claims: opts.claims ?? { sub: 'sub-1', email: 'user@test.mz' }, scopes: [] } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function membership(tenantId: string, name: string) {
  return { tenantId, userId: 'user-1', role: 'OWNER', tenant: { id: tenantId, name, plan: 'DEMO' } };
}

function stubDb(memberships: ReturnType<typeof membership>[]) {
  return {
    user: { upsert: vi.fn(async ({ create }: { create: { email: string } }) => ({ id: 'user-1', email: create.email, displayName: null })) },
    membership: { findMany: vi.fn(async () => memberships) },
    $queryRaw: vi.fn(async () => [{ ok: 1 }]),
  } as unknown as PrismaClient;
}

async function call(db: PrismaClient, method: string, path: string, opts: Parameters<typeof event>[2] = {}) {
  const res = await createHandler(db, crypto)(event(method, path, opts));
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe('api router auth and routing', () => {
  it('returns 401 without a token subject', async () => {
    const res = await call(stubDb([membership('t1', 'A')]), 'GET', '/v1/dashboard', { claims: {} });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('health checks the database', async () => {
    const res = await call(stubDb([]), 'GET', '/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('answers CORS preflight with 204 before auth', async () => {
    const res = await createHandler(stubDb([]), crypto)(event('OPTIONS', '/v1/plans'));
    expect(res.statusCode).toBe(204);
  });

  it('serves a nested plan catalogue without auth', async () => {
    const res = await call(stubDb([]), 'GET', '/v1/plans', { claims: {} });
    expect(res.status).toBe(200);
    const body = res.body as {
      families: { ACCOUNTANT: PlanDto[]; COMPANY: PlanDto[] };
      revenueThresholds: { plan: string; minMzn: number; maxMzn: number | null }[];
    };
    expect(body.families.ACCOUNTANT).toHaveLength(3);
    expect(body.families.COMPANY).toHaveLength(4);
    const plan = body.families.ACCOUNTANT[0];
    expect(plan.family).toBe('ACCOUNTANT');
    expect(typeof plan.description).toBe('string');
    expect(typeof plan.limits.maxCompanies).toBe('number');
    expect(Array.isArray(plan.limits.simulatorAccess)).toBe(true);
    expect(body.revenueThresholds[0]).toEqual({ plan: 'COMPANY_MICRO', minMzn: 0, maxMzn: 2_500_000 });
  });

  it('suggests a nested company plan from revenue without auth', async () => {
    const res = await call(stubDb([]), 'GET', '/v1/plans/suggest', { claims: {}, query: { annualRevenueMzn: '5000000' } });
    expect(res.status).toBe(200);
    const body = res.body as { annualRevenueMzn: number; suggested: PlanDto };
    expect(body.annualRevenueMzn).toBe(5_000_000);
    expect(body.suggested.code).toBe('COMPANY_PEQUENA');
    expect(typeof body.suggested.limits.maxUsers).toBe('number');
  });

  it('returns 403 NO_TENANT for users without membership', async () => {
    const res = await call(stubDb([]), 'GET', '/v1/dashboard');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_TENANT');
  });

  it('returns 400 TENANT_REQUIRED for multi-tenant users without a header', async () => {
    const res = await call(stubDb([membership('t1', 'A'), membership('t2', 'B')]), 'GET', '/v1/dashboard');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TENANT_REQUIRED');
  });

  it('rejects a tenant header the user does not belong to', async () => {
    const res = await call(stubDb([membership('t1', 'A')]), 'GET', '/v1/dashboard', { headers: { 'x-tenant-id': 't2' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_ACCESS_DENIED');
  });

  it('serves the simulator registry for a valid member', async () => {
    const res = await call(stubDb([membership('t1', 'A')]), 'GET', '/v1/simulators');
    expect(res.status).toBe(200);
    const items = res.body.items as { code: string }[];
    expect(items.length).toBeGreaterThanOrEqual(12);
    expect(items.map((i) => i.code)).toContain('IVA');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await call(stubDb([membership('t1', 'A')]), 'GET', '/v1/unknown');
    expect(res.status).toBe(404);
  });

  it('rejects invalid simulator input with 422', async () => {
    const db = stubDb([membership('t1', 'A')]);
    (db as unknown as { company: { findFirst: () => Promise<null> } }).company = { findFirst: async () => null };
    (db as unknown as { $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).$transaction = async (fn) => fn(db);
    (db as unknown as { $queryRaw: () => Promise<unknown[]> }).$queryRaw = async () => [];
    const res = await call(db, 'POST', '/v1/simulators/IVA', { body: undefined });
    expect([400, 422]).toContain(res.status);
  });
});
