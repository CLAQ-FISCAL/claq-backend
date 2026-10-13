import { Prisma } from '@prisma/client';
import { AppError } from './http';

export type PlanFamily = 'DEMO' | 'ACCOUNTANT' | 'COMPANY';

export type AccountantPlanCode = 'ACCOUNTANT_FREE' | 'ACCOUNTANT_PRO' | 'ACCOUNTANT_PREMIUM';
export type CompanyPlanCode = 'COMPANY_MICRO' | 'COMPANY_PEQUENA' | 'COMPANY_MEDIA' | 'COMPANY_GRANDE';
export type PlanCode = 'DEMO' | AccountantPlanCode | CompanyPlanCode;

export const ACCOUNTANT_PLAN_CODES: readonly AccountantPlanCode[] = ['ACCOUNTANT_FREE', 'ACCOUNTANT_PRO', 'ACCOUNTANT_PREMIUM'];
export const COMPANY_PLAN_CODES: readonly CompanyPlanCode[] = ['COMPANY_MICRO', 'COMPANY_PEQUENA', 'COMPANY_MEDIA', 'COMPANY_GRANDE'];

export type PlanFeature = 'FISCAL_CALENDAR' | 'ALERTS' | 'RISK_SCORE' | 'AUDIT' | 'BRANCHES' | 'MULTI_ENTERPRISE' | 'MULTI_CONTRIBUTION';

export const PLAN_LABELS: Record<PlanCode, string> = {
  DEMO: 'Demo (Investidores)',
  ACCOUNTANT_FREE: 'Início de Carteira',
  ACCOUNTANT_PRO: 'Carteira em Crescimento',
  ACCOUNTANT_PREMIUM: 'Carteira Alargada / Escritório',
  COMPANY_MICRO: 'Micro / EI',
  COMPANY_PEQUENA: 'Pequena Empresa',
  COMPANY_MEDIA: 'Média Empresa',
  COMPANY_GRANDE: 'Grande Empresa / Grupo',
};

export const GB = 1024 ** 3;

/** Empresas tiers keyed by declared annual revenue (MZN). Boundaries are inclusive of the lower bound. */
export const REVENUE_THRESHOLDS = [
  { plan: 'COMPANY_MICRO' as const, maxAnnualRevenueMzn: 2_500_000 as number | null },
  { plan: 'COMPANY_PEQUENA' as const, maxAnnualRevenueMzn: 25_000_000 as number | null },
  { plan: 'COMPANY_MEDIA' as const, maxAnnualRevenueMzn: 100_000_000 as number | null },
  { plan: 'COMPANY_GRANDE' as const, maxAnnualRevenueMzn: null as number | null },
];

export type PlanLimits = {
  code: PlanCode;
  family: PlanFamily;
  label: string;
  maxCompanies: number;
  maxUsers: number;
  simulatorAccess: 'all' | 'core';
  coreSimulatorCodes: readonly string[];
  notificationChannels: readonly string[];
  maxLeadDaysEntries: number;
  storageLimitBytes: number | null;
  features: readonly PlanFeature[];
  annualRevenueMaxMzn: number | null;
};

export const CORE_SIMULATORS = ['IVA', 'IRPS_RETENCAO', 'IRPC_ESTIMATIVA', 'INSS', 'SALARIO_LIQUIDO', 'CUSTO_TRABALHADOR', 'MULTAS_JUROS'] as const;
export const ALL_SIMULATORS = [...CORE_SIMULATORS, 'NAO_RESIDENTE', 'HORAS_EXTRAS', 'FERIAS', 'INDEMNIZACAO', 'SELO', 'TAE'] as const;

const ALL_CHANNELS = ['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP'] as const;

const ACCOUNTANT_FEATURES: readonly PlanFeature[] = ['FISCAL_CALENDAR', 'ALERTS'];
const DEMO_FEATURES: readonly PlanFeature[] = ['FISCAL_CALENDAR', 'ALERTS', 'RISK_SCORE', 'AUDIT', 'BRANCHES', 'MULTI_ENTERPRISE', 'MULTI_CONTRIBUTION'];
const MICRO_FEATURES: readonly PlanFeature[] = ['FISCAL_CALENDAR', 'ALERTS'];
const PEQUENA_FEATURES: readonly PlanFeature[] = ['FISCAL_CALENDAR', 'ALERTS', 'RISK_SCORE'];
const MEDIA_FEATURES: readonly PlanFeature[] = ['FISCAL_CALENDAR', 'ALERTS', 'RISK_SCORE', 'AUDIT', 'BRANCHES'];
const GRANDE_FEATURES: readonly PlanFeature[] = ['FISCAL_CALENDAR', 'ALERTS', 'RISK_SCORE', 'AUDIT', 'BRANCHES', 'MULTI_ENTERPRISE', 'MULTI_CONTRIBUTION'];

const PLAN_LIMITS: Record<PlanCode, PlanLimits> = {
  DEMO: {
    code: 'DEMO',
    family: 'DEMO',
    label: PLAN_LABELS.DEMO,
    maxCompanies: Infinity,
    maxUsers: Infinity,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ALL_CHANNELS,
    maxLeadDaysEntries: 8,
    storageLimitBytes: null,
    features: DEMO_FEATURES,
    annualRevenueMaxMzn: null,
  },
  ACCOUNTANT_FREE: {
    code: 'ACCOUNTANT_FREE',
    family: 'ACCOUNTANT',
    label: PLAN_LABELS.ACCOUNTANT_FREE,
    maxCompanies: 3,
    maxUsers: Infinity,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ALL_CHANNELS,
    maxLeadDaysEntries: 8,
    storageLimitBytes: null,
    features: ACCOUNTANT_FEATURES,
    annualRevenueMaxMzn: null,
  },
  ACCOUNTANT_PRO: {
    code: 'ACCOUNTANT_PRO',
    family: 'ACCOUNTANT',
    label: PLAN_LABELS.ACCOUNTANT_PRO,
    maxCompanies: 20,
    maxUsers: Infinity,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ALL_CHANNELS,
    maxLeadDaysEntries: 8,
    storageLimitBytes: null,
    features: ACCOUNTANT_FEATURES,
    annualRevenueMaxMzn: null,
  },
  ACCOUNTANT_PREMIUM: {
    code: 'ACCOUNTANT_PREMIUM',
    family: 'ACCOUNTANT',
    label: PLAN_LABELS.ACCOUNTANT_PREMIUM,
    maxCompanies: Infinity,
    maxUsers: Infinity,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ALL_CHANNELS,
    maxLeadDaysEntries: 8,
    storageLimitBytes: null,
    features: ACCOUNTANT_FEATURES,
    annualRevenueMaxMzn: null,
  },
  COMPANY_MICRO: {
    code: 'COMPANY_MICRO',
    family: 'COMPANY',
    label: PLAN_LABELS.COMPANY_MICRO,
    maxCompanies: 1,
    maxUsers: 1,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ALL_CHANNELS,
    maxLeadDaysEntries: 8,
    storageLimitBytes: 0,
    features: MICRO_FEATURES,
    annualRevenueMaxMzn: 2_500_000,
  },
  COMPANY_PEQUENA: {
    code: 'COMPANY_PEQUENA',
    family: 'COMPANY',
    label: PLAN_LABELS.COMPANY_PEQUENA,
    maxCompanies: 1,
    maxUsers: 3,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ALL_CHANNELS,
    maxLeadDaysEntries: 8,
    storageLimitBytes: 5 * GB,
    features: PEQUENA_FEATURES,
    annualRevenueMaxMzn: 25_000_000,
  },
  COMPANY_MEDIA: {
    code: 'COMPANY_MEDIA',
    family: 'COMPANY',
    label: PLAN_LABELS.COMPANY_MEDIA,
    maxCompanies: 1,
    maxUsers: 15,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ALL_CHANNELS,
    maxLeadDaysEntries: 8,
    storageLimitBytes: null,
    features: MEDIA_FEATURES,
    annualRevenueMaxMzn: 100_000_000,
  },
  COMPANY_GRANDE: {
    code: 'COMPANY_GRANDE',
    family: 'COMPANY',
    label: PLAN_LABELS.COMPANY_GRANDE,
    maxCompanies: Infinity,
    maxUsers: Infinity,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ALL_CHANNELS,
    maxLeadDaysEntries: 8,
    storageLimitBytes: null,
    features: GRANDE_FEATURES,
    annualRevenueMaxMzn: null,
  },
};

export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as PlanCode] ?? PLAN_LIMITS.DEMO;
}

export function isValidPlan(plan: string): plan is PlanCode {
  return plan in PLAN_LIMITS;
}

export function getPlanFamily(plan: string): PlanFamily {
  return getPlanLimits(plan).family;
}

export function planHasFeature(plan: string, feature: PlanFeature): boolean {
  return getPlanLimits(plan).features.includes(feature);
}

/** Suggests the Empresas tier for a declared annual revenue in MZN (>= lower bound, < upper bound). */
export function suggestCompanyPlanCode(annualRevenueMzn: number): CompanyPlanCode {
  for (const tier of REVENUE_THRESHOLDS) {
    if (tier.maxAnnualRevenueMzn === null || annualRevenueMzn < tier.maxAnnualRevenueMzn) return tier.plan;
  }
  return 'COMPANY_GRANDE';
}

/** Plan a tenant falls back to after a subscription ends, based on its family. */
export function defaultPlanForFamily(family: string): PlanCode {
  switch (family.toUpperCase()) {
    case 'COMPANY':
      return 'COMPANY_MICRO';
    case 'DEMO':
      return 'DEMO';
    default:
      return 'ACCOUNTANT_FREE';
  }
}

export async function enforceCompanyLimit(tx: Prisma.TransactionClient, tenantId: string, plan: string): Promise<void> {
  const limits = getPlanLimits(plan);
  if (limits.maxCompanies === Infinity) return;
  const count = await tx.company.count({ where: { tenantId } });
  if (count >= limits.maxCompanies) {
    throw new AppError(403, 'PLAN_LIMIT_EXCEEDED', `Your ${limits.label} plan allows up to ${limits.maxCompanies} companies. Upgrade to add more.`);
  }
}

export async function enforceUserLimit(tx: Prisma.TransactionClient, tenantId: string, plan: string): Promise<void> {
  const limits = getPlanLimits(plan);
  if (limits.maxUsers === Infinity) return;
  const count = await tx.membership.count({ where: { tenantId } });
  if (count >= limits.maxUsers) {
    throw new AppError(403, 'PLAN_LIMIT_EXCEEDED', `Your ${limits.label} plan allows up to ${limits.maxUsers} users. Upgrade to add more.`);
  }
}

export function assertSimulatorAccess(plan: string, simulatorCode: string): void {
  const limits = getPlanLimits(plan);
  if (limits.simulatorAccess === 'all') return;
  if (!limits.coreSimulatorCodes.includes(simulatorCode)) {
    throw new AppError(403, 'SIMULATOR_NOT_AVAILABLE', `The '${simulatorCode}' simulator is not available on the ${limits.label} plan.`);
  }
}

export function assertNotificationChannel(plan: string, channel: string): void {
  const limits = getPlanLimits(plan);
  if (!limits.notificationChannels.includes(channel)) {
    throw new AppError(403, 'CHANNEL_NOT_AVAILABLE', `The '${channel}' notification channel is not available on the ${limits.label} plan.`);
  }
}
