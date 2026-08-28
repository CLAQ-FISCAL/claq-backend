import { Prisma } from '@prisma/client';
import { AppError } from './http';

export type PlanCode = 'DEMO' | 'ACCOUNTANT_OFFICE' | 'PME_CORPORATE';

export const PLAN_LABELS: Record<PlanCode, string> = {
  DEMO: 'Demo (Investidores)',
  ACCOUNTANT_OFFICE: 'Escritório de Contabilidade',
  PME_CORPORATE: 'PME / Empresa Consultora',
};

export type PlanLimits = {
  label: string;
  maxCompanies: number;
  maxUsers: number;
  simulatorAccess: 'all' | 'core';
  coreSimulatorCodes: readonly string[];
  notificationChannels: readonly string[];
  maxLeadDaysEntries: number;
};

export const CORE_SIMULATORS = ['IVA', 'IRPS_RETENCAO', 'IRPC_ESTIMATIVA', 'INSS', 'SALARIO_LIQUIDO', 'CUSTO_TRABALHADOR', 'MULTAS_JUROS'] as const;
export const ALL_SIMULATORS = [...CORE_SIMULATORS, 'NAO_RESIDENTE', 'HORAS_EXTRAS', 'FERIAS', 'INDEMNIZACAO', 'SELO', 'TAE'] as const;

const PLAN_LIMITS: Record<PlanCode, PlanLimits> = {
  DEMO: {
    label: 'Demo (Investidores)',
    maxCompanies: Infinity,
    maxUsers: Infinity,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP'],
    maxLeadDaysEntries: 8,
  },
  ACCOUNTANT_OFFICE: {
    label: 'Escritório de Contabilidade',
    maxCompanies: 100,
    maxUsers: 10,
    simulatorAccess: 'all',
    coreSimulatorCodes: ALL_SIMULATORS,
    notificationChannels: ['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP'],
    maxLeadDaysEntries: 8,
  },
  PME_CORPORATE: {
    label: 'PME / Empresa Consultora',
    maxCompanies: 3,
    maxUsers: 3,
    simulatorAccess: 'core',
    coreSimulatorCodes: CORE_SIMULATORS,
    notificationChannels: ['EMAIL', 'IN_APP'],
    maxLeadDaysEntries: 4,
  },
};

export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as PlanCode] ?? PLAN_LIMITS.DEMO;
}

export function isValidPlan(plan: string): plan is PlanCode {
  return plan in PLAN_LIMITS;
}

export async function enforceCompanyLimit(tx: Prisma.TransactionClient, tenantId: string, plan: string): Promise<void> {
  const limits = getPlanLimits(plan);
  if (limits.maxCompanies === Infinity) return;
  const count = await tx.company.count({ where: { tenantId } });
  if (count >= limits.maxCompanies) {
    throw new AppError(403, 'PLAN_LIMIT_EXCEEDED', `Your ${limits.label} plan allows up to ${limits.maxCompanies} companies. Upgrade to add more.`);
  }
}

export function assertSimulatorAccess(plan: string, simulatorCode: string): void {
  const limits = getPlanLimits(plan);
  if (limits.simulatorAccess === 'all') return;
  if (!limits.coreSimulatorCodes.includes(simulatorCode)) {
    throw new AppError(403, 'SIMULATOR_NOT_AVAILABLE', `The '${simulatorCode}' simulator requires the ${PLAN_LABELS.ACCOUNTANT_OFFICE} plan.`);
  }
}

export function assertNotificationChannel(plan: string, channel: string): void {
  const limits = getPlanLimits(plan);
  if (!limits.notificationChannels.includes(channel)) {
    throw new AppError(403, 'CHANNEL_NOT_AVAILABLE', `The '${channel}' notification channel requires the ${PLAN_LABELS.ACCOUNTANT_OFFICE} plan.`);
  }
}
