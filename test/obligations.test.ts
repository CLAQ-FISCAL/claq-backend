import { describe, expect, it } from 'vitest';
import { dueDateFor, occurrencesFor, parseTemplate, validateStatusTransition } from '../src/domain/obligations';
import { daysUntil, planReminders, utcDay } from '../src/domain/reminders';

describe('dueDateFor', () => {
  it('clamps to the month length', () => {
    expect(dueDateFor(2026, 2, 31).toISOString()).toBe('2026-02-28T23:59:59.000Z');
    expect(dueDateFor(2024, 2, 31).toISOString()).toBe('2024-02-29T23:59:59.000Z');
    expect(dueDateFor(2026, 4, 31).toISOString()).toBe('2026-04-30T23:59:59.000Z');
  });
});

describe('occurrencesFor', () => {
  it('expands monthly templates to 12 dates', () => {
    const dates = occurrencesFor({ title: 'IVA', category: 'TAX', periodicity: 'MONTHLY', dueDay: 15 }, 2026);
    expect(dates).toHaveLength(12);
    expect(dates[0].getUTCMonth()).toBe(0);
    expect(dates[11].getUTCMonth()).toBe(11);
  });

  it('expands annual templates to one date in the configured month', () => {
    const dates = occurrencesFor({ title: 'TAE', category: 'MUNICIPAL', periodicity: 'ANNUAL', dueDay: 31, month: 3 }, 2026);
    expect(dates).toHaveLength(1);
    expect(dates[0].toISOString()).toBe('2026-03-31T23:59:59.000Z');
  });
});

describe('parseTemplate', () => {
  it('accepts valid templates', () => {
    const t = parseTemplate({ kind: 'OBLIGATION_TEMPLATE', title: 'IVA', category: 'TAX', periodicity: 'MONTHLY', dueDay: 15 });
    expect(t?.title).toBe('IVA');
  });

  it('ignores non-template rules', () => {
    expect(parseTemplate({ kind: 'RATE_TABLE', standardRate: 0.16 })).toBeNull();
  });

  it('rejects invalid content', () => {
    expect(() => parseTemplate({ kind: 'OBLIGATION_TEMPLATE', title: '', periodicity: 'MONTHLY', dueDay: 15 })).toThrow(/title/);
    expect(() => parseTemplate({ kind: 'OBLIGATION_TEMPLATE', title: 'X', periodicity: 'WEEKLY', dueDay: 15 })).toThrow(/periodicity/);
    expect(() => parseTemplate({ kind: 'OBLIGATION_TEMPLATE', title: 'X', periodicity: 'MONTHLY', dueDay: 40 })).toThrow(/dueDay/);
    expect(() => parseTemplate({ kind: 'OBLIGATION_TEMPLATE', title: 'X', periodicity: 'ANNUAL', dueDay: 10 })).toThrow(/month/);
  });
});

describe('validateStatusTransition', () => {
  it('allows settling and reopening', () => {
    expect(() => validateStatusTransition('UPCOMING', 'PAID')).not.toThrow();
    expect(() => validateStatusTransition('OVERDUE', 'SUBMITTED')).not.toThrow();
    expect(() => validateStatusTransition('PAID', 'UPCOMING')).not.toThrow();
    expect(() => validateStatusTransition('DUE', 'NOT_APPLICABLE')).not.toThrow();
  });

  it('forbids worker-managed and nonsensical transitions', () => {
    expect(() => validateStatusTransition('UPCOMING', 'DUE')).toThrow();
    expect(() => validateStatusTransition('UPCOMING', 'OVERDUE')).toThrow();
    expect(() => validateStatusTransition('PAID', 'PAID')).toThrow();
  });
});

describe('planReminders', () => {
  const today = utcDay(new Date(Date.UTC(2026, 5, 27)));
  const candidate = (id: string, tenantId: string, dueAt: Date, status: 'UPCOMING' | 'DUE' | 'OVERDUE' = 'UPCOMING') => ({
    id,
    tenantId,
    title: 'IVA',
    dueAt,
    status,
    companyLegalName: 'X, Lda',
  });
  const prefs = new Map([
    ['tenant-1', [7, 3, 1, 0]],
    ['tenant-off', []],
  ]);
  const at = (days: number) => new Date(today.getTime() + days * 86400000);

  it('plans exactly on configured lead days', () => {
    const plans = planReminders([candidate('a', 'tenant-1', at(3))], prefs, today);
    expect(plans).toEqual([{ tenantId: 'tenant-1', obligationId: 'a', leadDay: 3 }]);
    expect(planReminders([candidate('b', 'tenant-1', at(5))], prefs, today)).toEqual([]);
  });

  it('plans on the due date itself', () => {
    expect(planReminders([candidate('c', 'tenant-1', at(0), 'DUE')], prefs, today)).toEqual([{ tenantId: 'tenant-1', obligationId: 'c', leadDay: 0 }]);
  });

  it('emits a single overdue catch-up notice', () => {
    expect(planReminders([candidate('d', 'tenant-1', at(-10), 'OVERDUE')], prefs, today)).toEqual([{ tenantId: 'tenant-1', obligationId: 'd', leadDay: -1 }]);
  });

  it('skips tenants with reminders disabled', () => {
    expect(planReminders([candidate('e', 'tenant-off', at(3))], prefs, today)).toEqual([]);
  });

  it('computes calendar-day differences', () => {
    expect(daysUntil(new Date(Date.UTC(2026, 5, 30)), today)).toBe(3);
    expect(daysUntil(new Date(Date.UTC(2026, 5, 27)), today)).toBe(0);
    expect(daysUntil(new Date(Date.UTC(2026, 4, 27)), today)).toBe(-31);
  });
});
