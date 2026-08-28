import type { Prisma } from '@prisma/client';

export type ObligationDto = {
  id: string;
  companyId: string;
  companyLegalName: string;
  title: string;
  dueAt: string;
  status: string;
  ruleVersion: string;
};

export type DashboardSummary = {
  tenant: { id: string; name: string; plan: string };
  nextObligation: ObligationDto | null;
  counts: { pending: number; dueSoon: number; overdue: number; paid: number; total: number };
  compliancePct: number;
  upcoming: ObligationDto[];
};

export function toDto(o: { id: string; companyId: string; title: string; dueAt: Date; status: string; ruleVersion: string; company?: { legalName: string } | null }): ObligationDto {
  return {
    id: o.id,
    companyId: o.companyId,
    companyLegalName: o.company?.legalName ?? '',
    title: o.title,
    dueAt: o.dueAt.toISOString(),
    status: o.status,
    ruleVersion: o.ruleVersion,
  };
}

const SETTLED = new Set(['PAID', 'SUBMITTED']);

export async function dashboardSummary(tx: Prisma.TransactionClient, tenant: { id: string; name: string; plan: string }, now: Date): Promise<DashboardSummary> {
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const in30Days = new Date(now.getTime() + 30 * 86400000);
  const obligations = await tx.obligation.findMany({
    where: { tenantId: tenant.id, dueAt: { gte: yearStart } },
    orderBy: [{ dueAt: 'asc' }, { title: 'asc' }],
    include: { company: { select: { legalName: true } } },
  });

  const active = obligations.filter((o) => o.status === 'UPCOMING' || o.status === 'DUE');
  const overdue = obligations.filter((o) => o.status === 'OVERDUE');
  const paid = obligations.filter((o) => SETTLED.has(o.status));
  const dueSoon = active.filter((o) => o.dueAt <= in30Days);
  const relevant = obligations.filter((o) => o.status !== 'NOT_APPLICABLE');
  const compliancePct = relevant.length === 0 ? 100 : Math.round((100 * paid.length) / relevant.length);

  return {
    tenant,
    nextObligation: active.length > 0 ? toDto(active[0]) : null,
    counts: { pending: active.length, dueSoon: dueSoon.length, overdue: overdue.length, paid: paid.length, total: obligations.length },
    compliancePct,
    upcoming: active.slice(0, 5).map(toDto),
  };
}
