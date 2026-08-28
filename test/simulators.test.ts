import { describe, expect, it } from 'vitest';
import type { ApprovedRule } from '../src/rules';
import { parseInputs, runSimulator } from '../src/simulators/engine';
import { getSimulator, simulators } from '../src/simulators/definitions';

const FIXTURE_RULES: Record<string, Record<string, unknown>> = {
  IVA_RATE: { standardRate: 0.16 },
  IRPS_BRACKETS: {
    monthlyBrackets: [
      { upto: 20999, rate: 0.1 },
      { upto: 49999, rate: 0.15 },
      { upto: 149999, rate: 0.2 },
      { upto: null, rate: 0.25 },
    ],
  },
  IRPC_RATE: { standardRate: 0.32, reducedRate: 0.2 },
  INSS_RATES: { employeeRate: 0.03, employerRate: 0.04 },
  PENALTY_RATES: { annualInterestRate: 0.1, fineRate: 0.1 },
  NONRESIDENT_SERVICE: { grossUpFactor: 1.25, vatRate: 0.16, withholdingRate: 0.2 },
  OVERTIME_RATES: { weekday: 1.5, weekend: 2, holiday: 2.5, night: 1.25 },
  LEAVE_RULES: { maxSubsidyMonths: 1 },
  SEVERANCE_RULES: { daysPerYear: 3 },
  STAMP_DUTY: { table: [{ code: 'ARRENDAMENTO', label: 'Arrendamento', rate: 0.1 }] },
  TAE_BRACKETS: {
    brackets: [
      { upto: 2500000, fixed: 2500 },
      { upto: null, fixed: 37500 },
    ],
  },
};

const loader = async (code: string): Promise<ApprovedRule> => ({
  code,
  version: 'test.1',
  content: FIXTURE_RULES[code],
  sourceUrl: 'https://test.local/diploma',
  effectiveFrom: new Date(0),
  effectiveTo: null,
});

async function run(code: string, inputs: Record<string, unknown>) {
  const sim = getSimulator(code);
  if (!sim) throw new Error(`simulator ${code} missing`);
  return runSimulator(sim, parseInputs(sim, inputs), loader);
}

describe('simulator registry', () => {
  it('exposes unique codes with inputs and rule codes', () => {
    const codes = simulators.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const sim of simulators) {
      expect(sim.inputs.length).toBeGreaterThan(0);
      expect(sim.ruleCodes.length).toBeGreaterThan(0);
    }
  });
});

describe('IVA', () => {
  it('matches the product reference example (16%)', async () => {
    const result = await run('IVA', { vendas: '100000', compras: '50000' });
    expect(result.total).toBe('8000.00');
    expect(result.ruleVersions).toEqual([{ code: 'IVA_RATE', version: 'test.1' }]);
  });

  it('never returns a negative payable', async () => {
    const result = await run('IVA', { vendas: '1000', compras: '5000' });
    expect(result.total).toBe('0.00');
  });
});

describe('NAO_RESIDENTE', () => {
  it('matches the product mock: 10,000 USD @ 63.75, gross-up 1.25, IVA 16%, IRPC 20%', async () => {
    const result = await run('NAO_RESIDENTE', { valorFatura: '10000', cambio: '63.75' });
    const contraValor = result.lines.find((l) => l.label.startsWith('Contra-valor'));
    const base = result.lines.find((l) => l.label.startsWith('Base majorada'));
    const iva = result.lines.find((l) => l.label.startsWith('IVA'));
    const retencao = result.lines.find((l) => l.label.startsWith('Retenção'));
    expect(contraValor?.amount).toBe('637500.00');
    expect(base?.amount).toBe('796875.00');
    expect(iva?.amount).toBe('127500.00');
    expect(retencao?.amount).toBe('159375.00');
    expect(result.total).toBe('286875.00');
  });
});

describe('SALARIO_LIQUIDO', () => {
  it('applies INSS then progressive IRPS', async () => {
    const result = await run('SALARIO_LIQUIDO', { salarioBruto: '50000' });
    // INSS 1,500.00; IRPS 6,225.05; net 42,274.95
    expect(result.total).toBe('42274.95');
    const irps = result.lines.find((l) => l.label.includes('IRPS'));
    expect(irps?.amount).toBe('6225.05');
  });
});

describe('labor simulators', () => {
  it('INSS splits employee and employer shares', async () => {
    const result = await run('INSS', { salarioBruto: '50000' });
    expect(result.total).toBe('3500.00');
  });

  it('CUSTO_TRABALHADOR adds the employer share', async () => {
    const result = await run('CUSTO_TRABALHADOR', { salarioBruto: '50000' });
    expect(result.total).toBe('52000.00');
  });

  it('HORAS_EXTRAS applies the multiplier per day type', async () => {
    expect((await run('HORAS_EXTRAS', { valorHora: '100', horas: '10', tipoDia: 'WEEKDAY' })).total).toBe('1500.00');
    expect((await run('HORAS_EXTRAS', { valorHora: '100', horas: '10', tipoDia: 'NIGHT' })).total).toBe('1250.00');
  });

  it('FERIAS prorates the subsidy', async () => {
    expect((await run('FERIAS', { salarioMensal: '42000', mesesTrabalhados: '6' })).total).toBe('21000.00');
  });

  it('INDEMNIZACAO prorates partial years', async () => {
    // 3a 6m × 3 days/year = 10.5 days → 30,000 × 10.5/30
    expect((await run('INDEMNIZACAO', { salarioMensal: '30000', anos: '3', meses: '6' })).total).toBe('10500.00');
  });
});

describe('fiscal simulators', () => {
  it('IRPC_ESTIMATIVA honours the regime', async () => {
    expect((await run('IRPC_ESTIMATIVA', { lucroTributavel: '1000000', regime: 'GENERAL' })).total).toBe('320000.00');
    expect((await run('IRPC_ESTIMATIVA', { lucroTributavel: '1000000', regime: 'REDUCED' })).total).toBe('200000.00');
  });

  it('MULTAS_JUROS accrues daily interest', async () => {
    // 10,000 × 10%/365 × 30 = 82.19 + fine 1,000.00
    expect((await run('MULTAS_JUROS', { principal: '10000', diasAtraso: '30' })).total).toBe('1082.19');
  });

  it('SELO looks up the act table', async () => {
    expect((await run('SELO', { base: '500000', ato: 'ARRENDAMENTO' })).total).toBe('50000.00');
  });

  it('TAE picks the fixed bracket', async () => {
    expect((await run('TAE', { receitaAnual: '1000000' })).total).toBe('2500.00');
    expect((await run('TAE', { receitaAnual: '100000000' })).total).toBe('37500.00');
  });
});

describe('parseInputs', () => {
  it('rejects missing, negative and non-select values', async () => {
    const sim = getSimulator('IVA')!;
    expect(() => parseInputs(sim, { vendas: '100' })).toThrow(/compras/);
    expect(() => parseInputs(sim, { vendas: '-5', compras: '0' })).toThrow(/non-negative/);
    expect(() => parseInputs(sim, { vendas: 'abc', compras: '0' })).toThrow(/number/);
    const tae = getSimulator('HORAS_EXTRAS')!;
    expect(() => parseInputs(tae, { valorHora: '1', horas: '1', tipoDia: 'SUNDAY' })).toThrow(/Invalid value/);
  });

  it('rounds integers to nearest whole value', () => {
    const sim = getSimulator('MULTAS_JUROS')!;
    const inputs = parseInputs(sim, { principal: '100', diasAtraso: '10.9' });
    expect(String(inputs.diasAtraso)).toBe('11');
  });
});
