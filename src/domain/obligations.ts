import { Prisma } from '@prisma/client';
import { AppError } from '../lib/http';
import type { RuleContent } from '../rules';

const TEMPLATE_KIND = 'OBLIGATION_TEMPLATE';

export type ObligationTemplate = {
  title: string;
  category: string;
  periodicity: 'MONTHLY' | 'ANNUAL';
  dueDay: number;
  month?: number;
};

export function parseTemplate(content: RuleContent): ObligationTemplate | null {
  if (content.kind !== TEMPLATE_KIND) return null;
  const { title, periodicity, dueDay } = content as { kind: unknown; title: unknown; periodicity: unknown; dueDay: unknown; category: unknown; month: unknown };
  if (typeof title !== 'string' || title.trim() === '') throw new AppError(500, 'RULE_CONTENT_INVALID', 'Obligation template needs a non-empty title.');
  if (periodicity !== 'MONTHLY' && periodicity !== 'ANNUAL') throw new AppError(500, 'RULE_CONTENT_INVALID', `Obligation template '${title}' has invalid periodicity.`);
  if (typeof dueDay !== 'number' || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new AppError(500, 'RULE_CONTENT_INVALID', `Obligation template '${title}' needs an integer dueDay 1-31.`);
  const month = typeof content.month === 'number' ? content.month : undefined;
  if (periodicity === 'ANNUAL' && (month === undefined || !Number.isInteger(month) || month < 1 || month > 12)) {
    throw new AppError(500, 'RULE_CONTENT_INVALID', `Annual obligation template '${title}' needs a month 1-12.`);
  }
  return { title: title.trim(), category: typeof content.category === 'string' ? content.category : 'TAX', periodicity, dueDay, month };
}

/** dueDay is clamped to the month length (31 -> Feb 28/29). */
export function dueDateFor(year: number, month: number, dueDay: number): Date {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(dueDay, daysInMonth), 23, 59, 59));
}

export function occurrencesFor(template: ObligationTemplate, year: number): Date[] {
  if (template.periodicity === 'ANNUAL') return [dueDateFor(year, template.month as number, template.dueDay)];
  return Array.from({ length: 12 }, (_, i) => dueDateFor(year, i + 1, template.dueDay));
}

export type GenerationResult = { created: number; skipped: number; templates: { code: string; version: string; title: string }[] };

/**
 * Materialises obligations for a company/year from APPROVED obligation-template rules.
 * Idempotent: an existing obligation with the same title and due date is never duplicated.
 */
export async function generateObligations(tx: Prisma.TransactionClient, opts: { tenantId: string; companyId: string; actorId?: string; requestId: string; year: number }): Promise<GenerationResult> {
  const { year } = opts;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError(422, 'INPUT_INVALID', 'Year must be an integer between 2000 and 2100.');
  const company = await tx.company.findFirst({ where: { id: opts.companyId, tenantId: opts.tenantId }, select: { id: true } });
  if (!company) throw new AppError(404, 'COMPANY_NOT_FOUND', 'Company not found in this tenant.');

  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1) - 1);
  const candidates = await tx.ruleSet.findMany({
    where: { status: 'APPROVED', effectiveFrom: { lte: yearEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: yearStart } }] },
    orderBy: [{ code: 'asc' }, { version: 'desc' }],
  });
  const latestByCode = new Map<string, (typeof candidates)[number]>();
  for (const rule of candidates) if (!latestByCode.has(rule.code)) latestByCode.set(rule.code, rule);

  const existing = await tx.obligation.findMany({
    where: { tenantId: opts.tenantId, companyId: opts.companyId, dueAt: { gte: yearStart, lte: yearEnd } },
    select: { title: true, dueAt: true },
  });
  const seen = new Set(existing.map((o) => `${o.title}|${o.dueAt.toISOString().slice(0, 10)}`));

  let created = 0;
  let skipped = 0;
  const usedTemplates: GenerationResult['templates'] = [];
  for (const rule of latestByCode.values()) {
    const template = parseTemplate(rule.content as RuleContent);
    if (!template) continue;
    let used = false;
    for (const dueAt of occurrencesFor(template, year)) {
      if (dueAt < rule.effectiveFrom || (rule.effectiveTo !== null && dueAt > rule.effectiveTo)) {
        skipped++;
        continue;
      }
      const key = `${template.title}|${dueAt.toISOString().slice(0, 10)}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      await tx.obligation.create({
        data: {
          tenantId: opts.tenantId,
          companyId: opts.companyId,
          title: template.title,
          dueAt,
          status: 'UPCOMING',
          ruleVersion: rule.version,
          sourceSnapshot: { code: rule.code, template, sourceUrl: rule.sourceUrl },
        },
      });
      created++;
      used = true;
    }
    if (used) usedTemplates.push({ code: rule.code, version: rule.version, title: template.title });
  }
  if (created > 0) {
    await tx.auditEvent.create({
      data: {
        tenantId: opts.tenantId,
        actorId: opts.actorId ?? null,
        action: 'OBLIGATIONS_GENERATED',
        entityType: 'Company',
        entityId: opts.companyId,
        requestId: opts.requestId,
        after: { year, created, skipped, templates: usedTemplates },
      },
    });
  }
  return { created, skipped, templates: usedTemplates };
}

/** Daily status maintenance: UPCOMING -> DUE on the due date, -> OVERDUE after it. */
export async function syncObligationStatuses(tx: Prisma.TransactionClient, today: Date): Promise<number> {
  const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const tomorrow = new Date(dayStart.getTime() + 86400000);
  const due = await tx.obligation.updateMany({ where: { status: 'UPCOMING', dueAt: { gte: dayStart, lt: tomorrow } }, data: { status: 'DUE' } });
  const overdue = await tx.obligation.updateMany({ where: { status: { in: ['UPCOMING', 'DUE'] }, dueAt: { lt: dayStart } }, data: { status: 'OVERDUE' } });
  return due.count + overdue.count;
}

/** Manual transitions only; DUE/OVERDUE are owned by the daily sync. */
export function validateStatusTransition(from: string, to: string): void {
  const settled = ['PAID', 'SUBMITTED'];
  const allowed: Record<string, string[]> = {
    UPCOMING: [...settled, 'NOT_APPLICABLE'],
    DUE: [...settled, 'NOT_APPLICABLE'],
    OVERDUE: [...settled, 'NOT_APPLICABLE'],
    PAID: ['UPCOMING', 'NOT_APPLICABLE'],
    SUBMITTED: ['UPCOMING', 'NOT_APPLICABLE'],
    NOT_APPLICABLE: ['UPCOMING'],
  };
  if (!(allowed[from] ?? []).includes(to)) {
    throw new AppError(422, 'INVALID_TRANSITION', `Cannot change obligation status from ${from} to ${to}.`);
  }
}
