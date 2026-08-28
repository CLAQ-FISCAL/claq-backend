export type ReminderCandidate = {
  id: string;
  tenantId: string;
  title: string;
  dueAt: Date;
  status: 'UPCOMING' | 'DUE' | 'OVERDUE';
  companyLegalName: string;
};

export type PlannedReminder = { tenantId: string; obligationId: string; leadDay: number };

export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function daysUntil(dueAt: Date, today: Date): number {
  return Math.round((utcDay(dueAt).getTime() - utcDay(today).getTime()) / 86400000);
}

/**
 * Pure planner: for each candidate, emit one reminder per configured lead day that
 * matches today. Overdue obligations get a single catch-up notice (leadDay -1);
 * the NotificationAttempt unique index guarantees no duplicates.
 */
export function planReminders(candidates: ReminderCandidate[], leadDaysByTenant: Map<string, number[]>, today: Date): PlannedReminder[] {
  const plans: PlannedReminder[] = [];
  for (const candidate of candidates) {
    const leadDays = leadDaysByTenant.get(candidate.tenantId);
    if (!leadDays || leadDays.length === 0) continue;
    const days = daysUntil(candidate.dueAt, today);
    if (days >= 0) {
      for (const lead of leadDays) {
        if (lead === days) plans.push({ tenantId: candidate.tenantId, obligationId: candidate.id, leadDay: lead });
      }
    } else {
      plans.push({ tenantId: candidate.tenantId, obligationId: candidate.id, leadDay: -1 });
    }
  }
  return plans;
}
