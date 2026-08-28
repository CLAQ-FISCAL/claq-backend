import { describe, expect, it } from 'vitest';
import { getPlanLimits, isValidPlan, CORE_SIMULATORS, ALL_SIMULATORS, PLAN_LABELS, type PlanCode } from '../src/lib/plans';

describe('plan definitions', () => {
  it('recognizes all three plans', () => {
    expect(isValidPlan('DEMO')).toBe(true);
    expect(isValidPlan('ACCOUNTANT_OFFICE')).toBe(true);
    expect(isValidPlan('PME_CORPORATE')).toBe(true);
    expect(isValidPlan('UNKNOWN')).toBe(false);
  });

  it('falls back to DEMO limits for unknown plans', () => {
    const limits = getPlanLimits('NONEXISTENT');
    expect(limits.maxCompanies).toBe(Infinity);
    expect(limits.simulatorAccess).toBe('all');
  });

  it('DEMO has unlimited everything', () => {
    const d = getPlanLimits('DEMO');
    expect(d.maxCompanies).toBe(Infinity);
    expect(d.maxUsers).toBe(Infinity);
    expect(d.simulatorAccess).toBe('all');
    expect(d.notificationChannels).toEqual(['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP']);
  });

  it('ACCOUNTANT_OFFICE allows all simulators and all channels', () => {
    const a = getPlanLimits('ACCOUNTANT_OFFICE');
    expect(a.maxCompanies).toBe(100);
    expect(a.maxUsers).toBe(10);
    expect(a.simulatorAccess).toBe('all');
    expect(a.notificationChannels).toEqual(['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP']);
  });

  it('PME_CORPORATE restricts simulators and channels', () => {
    const p = getPlanLimits('PME_CORPORATE');
    expect(p.maxCompanies).toBe(3);
    expect(p.maxUsers).toBe(3);
    expect(p.simulatorAccess).toBe('core');
    expect(p.notificationChannels).toEqual(['EMAIL', 'IN_APP']);
  });

  it('PME_CORPORATE core simulators are a subset of all', () => {
    const p = getPlanLimits('PME_CORPORATE');
    for (const code of p.coreSimulatorCodes) {
      expect(ALL_SIMULATORS).toContain(code);
    }
    expect(p.coreSimulatorCodes.length).toBeLessThan(ALL_SIMULATORS.length);
  });

  it('ALL_SIMULATORS includes every known simulator code', () => {
    expect(ALL_SIMULATORS.length).toBe(13);
    expect(ALL_SIMULATORS).toContain('IVA');
    expect(ALL_SIMULATORS).toContain('TAE');
    expect(ALL_SIMULATORS).toContain('NAO_RESIDENTE');
  });

  it('plan labels are human-readable Portuguese', () => {
    expect(PLAN_LABELS.ACCOUNTANT_OFFICE).toContain('Contabilidade');
    expect(PLAN_LABELS.PME_CORPORATE).toContain('PME');
  });
});
