import { describe, expect, it } from 'vitest';
import {
  ACCOUNTANT_PLAN_CODES,
  COMPANY_PLAN_CODES,
  ALL_SIMULATORS,
  CORE_SIMULATORS,
  GB,
  PLAN_LABELS,
  REVENUE_THRESHOLDS,
  defaultPlanForFamily,
  getPlanFamily,
  getPlanLimits,
  isValidPlan,
  planHasFeature,
  suggestCompanyPlanCode,
} from '../src/lib/plans';

describe('plan definitions', () => {
  it('recognizes every plan code and rejects unknown ones', () => {
    for (const code of ['DEMO', ...ACCOUNTANT_PLAN_CODES, ...COMPANY_PLAN_CODES]) {
      expect(isValidPlan(code)).toBe(true);
    }
    expect(isValidPlan('UNKNOWN')).toBe(false);
    expect(isValidPlan('ACCOUNTANT_OFFICE')).toBe(false);
  });

  it('falls back to DEMO limits for unknown plans', () => {
    const limits = getPlanLimits('NONEXISTENT');
    expect(limits.family).toBe('DEMO');
    expect(limits.maxCompanies).toBe(Infinity);
    expect(limits.storageLimitBytes).toBeNull();
  });

  it('DEMO has unlimited everything and every feature', () => {
    const d = getPlanLimits('DEMO');
    expect(d.maxCompanies).toBe(Infinity);
    expect(d.maxUsers).toBe(Infinity);
    expect(d.features).toContain('MULTI_ENTERPRISE');
    expect(d.notificationChannels).toEqual(['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP']);
  });

  it('accountant plans scale the managed portfolio (3 / 20 / 60+)', () => {
    expect(getPlanLimits('ACCOUNTANT_FREE').maxCompanies).toBe(3);
    expect(getPlanLimits('ACCOUNTANT_PRO').maxCompanies).toBe(20);
    expect(getPlanLimits('ACCOUNTANT_PREMIUM').maxCompanies).toBe(Infinity);
    for (const code of ACCOUNTANT_PLAN_CODES) {
      expect(getPlanLimits(code).family).toBe('ACCOUNTANT');
      expect(planHasFeature(code, 'FISCAL_CALENDAR')).toBe(true);
      expect(planHasFeature(code, 'ALERTS')).toBe(true);
    }
  });

  it('company plans enforce user counts and storage caps', () => {
    expect(getPlanLimits('COMPANY_MICRO').maxUsers).toBe(1);
    expect(getPlanLimits('COMPANY_MICRO').storageLimitBytes).toBe(0);
    expect(getPlanLimits('COMPANY_PEQUENA').maxUsers).toBe(3);
    expect(getPlanLimits('COMPANY_PEQUENA').storageLimitBytes).toBe(5 * GB);
    expect(getPlanLimits('COMPANY_MEDIA').maxUsers).toBe(15);
    expect(getPlanLimits('COMPANY_GRANDE').maxUsers).toBe(Infinity);
    for (const code of COMPANY_PLAN_CODES) {
      expect(getPlanLimits(code).family).toBe('COMPANY');
    }
  });

  it('company features increase with the tier', () => {
    expect(planHasFeature('COMPANY_MICRO', 'RISK_SCORE')).toBe(false);
    expect(planHasFeature('COMPANY_PEQUENA', 'RISK_SCORE')).toBe(true);
    expect(planHasFeature('COMPANY_PEQUENA', 'AUDIT')).toBe(false);
    expect(planHasFeature('COMPANY_MEDIA', 'AUDIT')).toBe(true);
    expect(planHasFeature('COMPANY_MEDIA', 'BRANCHES')).toBe(true);
    expect(planHasFeature('COMPANY_MEDIA', 'MULTI_ENTERPRISE')).toBe(false);
    expect(planHasFeature('COMPANY_GRANDE', 'MULTI_ENTERPRISE')).toBe(true);
    expect(planHasFeature('COMPANY_GRANDE', 'MULTI_CONTRIBUTION')).toBe(true);
  });

  it('suggests the Empresas tier from annual revenue boundaries', () => {
    expect(suggestCompanyPlanCode(0)).toBe('COMPANY_MICRO');
    expect(suggestCompanyPlanCode(2_499_999)).toBe('COMPANY_MICRO');
    expect(suggestCompanyPlanCode(2_500_000)).toBe('COMPANY_PEQUENA');
    expect(suggestCompanyPlanCode(24_999_999)).toBe('COMPANY_PEQUENA');
    expect(suggestCompanyPlanCode(25_000_000)).toBe('COMPANY_MEDIA');
    expect(suggestCompanyPlanCode(99_999_999)).toBe('COMPANY_MEDIA');
    expect(suggestCompanyPlanCode(100_000_000)).toBe('COMPANY_GRANDE');
    expect(suggestCompanyPlanCode(5_000_000_000)).toBe('COMPANY_GRANDE');
  });

  it('revenue thresholds are ordered and cover the catalogue', () => {
    expect(REVENUE_THRESHOLDS.map((t) => t.plan)).toEqual([...COMPANY_PLAN_CODES]);
  });

  it('maps a plan to its family', () => {
    expect(getPlanFamily('ACCOUNTANT_PRO')).toBe('ACCOUNTANT');
    expect(getPlanFamily('COMPANY_MEDIA')).toBe('COMPANY');
    expect(getPlanFamily('DEMO')).toBe('DEMO');
  });

  it('downgrades to the family default plan', () => {
    expect(defaultPlanForFamily('ACCOUNTANT')).toBe('ACCOUNTANT_FREE');
    expect(defaultPlanForFamily('COMPANY')).toBe('COMPANY_MICRO');
    expect(defaultPlanForFamily('DEMO')).toBe('DEMO');
    expect(defaultPlanForFamily('anything-else')).toBe('ACCOUNTANT_FREE');
  });

  it('ALL_SIMULATORS includes every known simulator code', () => {
    expect(ALL_SIMULATORS.length).toBe(13);
    for (const code of CORE_SIMULATORS) expect(ALL_SIMULATORS).toContain(code);
    expect(ALL_SIMULATORS).toContain('TAE');
    expect(ALL_SIMULATORS).toContain('NAO_RESIDENTE');
  });

  it('plan labels are human-readable Portuguese', () => {
    expect(PLAN_LABELS.ACCOUNTANT_FREE).toContain('Carteira');
    expect(PLAN_LABELS.COMPANY_PEQUENA).toContain('Pequena');
    expect(PLAN_LABELS.COMPANY_GRANDE).toContain('Grupo');
  });
});
