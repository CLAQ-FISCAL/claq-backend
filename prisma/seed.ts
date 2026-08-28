/**
 * DEMO SEED — synthetic data only. Never load real customer data into demo.
 * Rules are seeded as DRAFT: an accountant must review + APPROVE them before any
 * simulator or obligation generator will use them (see docs/TAX-CONTENT.md).
 *
 * Usage: DATABASE_URL=postgresql://... npm run seed:demo
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RULE_SOURCE = 'https://www.at.gov.mz/ (placeholder — replace with the exact diploma URL during review)';

type RuleSeed = {
  code: string;
  version: string;
  content: Record<string, unknown>;
};

const RULES: RuleSeed[] = [
  { code: 'IVA_RATE', version: '2026.1-draft', content: { standardRate: 0.16 } },
  {
    code: 'IRPS_BRACKETS',
    version: '2026.1-draft',
    content: {
      monthlyBrackets: [
        { upto: 20999, rate: 0.1 },
        { upto: 49999, rate: 0.15 },
        { upto: 149999, rate: 0.2 },
        { upto: null, rate: 0.25 },
      ],
    },
  },
  { code: 'IRPC_RATE', version: '2026.1-draft', content: { standardRate: 0.32, reducedRate: 0.2 } },
  { code: 'INSS_RATES', version: '2026.1-draft', content: { employeeRate: 0.03, employerRate: 0.04 } },
  { code: 'PENALTY_RATES', version: '2026.1-draft', content: { annualInterestRate: 0.1, fineRate: 0.1 } },
  { code: 'NONRESIDENT_SERVICE', version: '2026.1-draft', content: { grossUpFactor: 1.25, vatRate: 0.16, withholdingRate: 0.2 } },
  { code: 'OVERTIME_RATES', version: '2026.1-draft', content: { weekday: 1.5, weekend: 2, holiday: 2.5, night: 1.25 } },
  { code: 'LEAVE_RULES', version: '2026.1-draft', content: { maxSubsidyMonths: 1 } },
  { code: 'SEVERANCE_RULES', version: '2026.1-draft', content: { daysPerYear: 3 } },
  {
    code: 'STAMP_DUTY',
    version: '2026.1-draft',
    content: {
      table: [
        { code: 'COMPRA_VENDA_IMOVEIS', label: 'Compra e venda de imóveis', rate: 0.02 },
        { code: 'JUROS_EMPRESTIMO', label: 'Juros de empréstimo', rate: 0.001 },
        { code: 'ARRENDAMENTO', label: 'Arrendamento', rate: 0.1 },
        { code: 'SEGUROS', label: 'Prémios de seguro', rate: 0.001 },
      ],
    },
  },
  {
    code: 'TAE_BRACKETS',
    version: '2026.1-draft',
    content: {
      brackets: [
        { upto: 2500000, fixed: 2500 },
        { upto: 25000000, fixed: 12500 },
        { upto: null, fixed: 37500 },
      ],
    },
  },
  { code: 'OBL_IVA_MONTHLY', version: '2026.1-draft', content: { kind: 'OBLIGATION_TEMPLATE', title: 'IVA — Declaração e Pagamento', category: 'TAX', periodicity: 'MONTHLY', dueDay: 15 } },
  { code: 'OBL_INSS_MONTHLY', version: '2026.1-draft', content: { kind: 'OBLIGATION_TEMPLATE', title: 'INSS — Contribuição Mensal', category: 'CONTRIBUTION', periodicity: 'MONTHLY', dueDay: 10 } },
  { code: 'OBL_IRPC_1ST', version: '2026.1-draft', content: { kind: 'OBLIGATION_TEMPLATE', title: 'IRPC — 1º Pagamento por Conta', category: 'TAX', periodicity: 'MONTHLY', dueDay: 15 } },
  { code: 'OBL_TAE_ANNUAL', version: '2026.1-draft', content: { kind: 'OBLIGATION_TEMPLATE', title: 'TAE — Taxa de Actividade Económica', category: 'MUNICIPAL', periodicity: 'ANNUAL', month: 3, dueDay: 31 } },
  { code: 'OBL_ALVARA_ANNUAL', version: '2026.1-draft', content: { kind: 'OBLIGATION_TEMPLATE', title: 'Alvará Comercial — Renovação Anual', category: 'MUNICIPAL', periodicity: 'ANNUAL', month: 2, dueDay: 28 } },
];

async function main(): Promise<void> {
  const year = new Date().getUTCFullYear();
  const tenantId = await prisma.$transaction(async (master) => {
    const tenant = await master.tenant.create({
      data: { name: 'CLAQ DEMO (ESCRITÓRIO DE CONTABILIDADE)', plan: 'ACCOUNTANT_OFFICE' },
    });
    await master.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

    await master.user.upsert({
      where: { cognitoSub: 'seed-not-bound' },
      update: {},
      create: { cognitoSub: 'seed-not-bound', email: 'demo-admin@claq.co.mz', displayName: 'Demo Admin (bind via RUNBOOK)' },
    }).then((user) => master.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'OWNER' } }).catch(() => undefined));

    for (const company of [
      { legalName: 'ABC Comércio, Lda (SYNTHETIC)', municipality: 'Maputo Cidade', taxRegime: 'IVA_GENERAL' },
      { legalName: 'SoftServ Moçambique, Lda (SYNTHETIC)', municipality: 'Matola', taxRegime: 'IVA_GENERAL' },
    ]) {
      await master.company.create({ data: { tenantId: tenant.id, ...company } });
    }

    for (const rule of RULES) {
      await master.ruleSet.upsert({
        where: { code_version: { code: rule.code, version: rule.version } },
        update: { content: rule.content },
        create: {
          code: rule.code,
          version: rule.version,
          status: 'DRAFT',
          effectiveFrom: new Date(Date.UTC(year, 0, 1)),
          content: rule.content,
          sourceUrl: RULE_SOURCE,
        },
      });
    }

    for (const channel of ['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP'] as const) {
      await master.notificationSetting.upsert({
        where: { tenantId_channel: { tenantId: tenant.id, channel } },
        update: {},
        create: { tenantId: tenant.id, channel, enabled: channel === 'EMAIL', leadDays: [7, 3, 1, 0] },
      });
    }

    // Synthetic obligations so the dashboard/calendar have data before rules are APPROVED.
    const companies = await master.company.findMany({ where: { tenantId: tenant.id }, select: { id: true, legalName: true } });
    const template = [
      { title: 'IVA — Declaração e Pagamento', day: 15 },
      { title: 'INSS — Contribuição Mensal', day: 10 },
    ];
    for (const company of companies) {
      for (const t of template) {
        for (let month = 1; month <= 12; month++) {
          const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
          await master.obligation.create({
            data: {
              tenantId: tenant.id,
              companyId: company.id,
              title: t.title,
              dueAt: new Date(Date.UTC(year, month - 1, Math.min(t.day, daysInMonth), 23, 59, 59)),
              status: 'UPCOMING',
              ruleVersion: 'seed-synthetic',
              sourceSnapshot: { synthetic: true },
            },
          });
        }
      }
      await master.obligation.create({
        data: {
          tenantId: tenant.id,
          companyId: company.id,
          title: 'TAE — Taxa de Actividade Económica',
          dueAt: new Date(Date.UTC(year, 2, 31, 23, 59, 59)),
          status: 'UPCOMING',
          ruleVersion: 'seed-synthetic',
          sourceSnapshot: { synthetic: true },
        },
      });
    }
    return tenant.id;
  });

  console.log(`Seeded demo tenant ${tenantId} with ${RULES.length} DRAFT rules, 2 synthetic companies and synthetic obligations for ${year}.`);
  console.log('Rules are DRAFT: approve via an accountant review before simulators/generators can use them.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
