import Decimal from 'decimal.js';
import { AppError } from '../lib/http';
import { contentBrackets, contentNumber, progressive, type ContentBracket } from '../rules';
import { line, money, type Simulator } from './engine';

/** Value of the first bracket whose ceiling covers `amount` (fixed-fee tables like TAE). */
function bracketFixed(amount: Decimal, brackets: ContentBracket[]): Decimal {
  for (const bracket of brackets) {
    if (bracket.upto === null || amount.lessThanOrEqualTo(bracket.upto)) return bracket.value;
  }
  return brackets[brackets.length - 1].value;
}

const SELECT_TAX_REGIME = [
  { value: 'GENERAL', label: 'Regime geral' },
  { value: 'REDUCED', label: 'Regime reduzido' },
];

export const simulators: Simulator[] = [
  {
    code: 'IVA',
    title: 'Simulador de IVA',
    category: 'FISCAL',
    description: 'Calcula o IVA a pagar ou a recuperar a partir das vendas e compras do mês.',
    ruleCodes: ['IVA_RATE'],
    inputs: [
      { name: 'vendas', label: 'Vendas do mês (sem IVA)', type: 'money', min: 0 },
      { name: 'compras', label: 'Compras do mês (sem IVA)', type: 'money', min: 0 },
    ],
    compute: async (inputs, { rule }) => {
      const rate = contentNumber((await rule('IVA_RATE')).content, 'standardRate');
      const vendas = inputs.vendas as Decimal;
      const compras = inputs.compras as Decimal;
      const outputVat = vendas.times(rate);
      const inputVat = compras.times(rate);
      const payable = Decimal.max(outputVat.minus(inputVat), 0);
      return [
        line('IVA sobre vendas (IVA liquidado)', `${money(vendas)} × ${rate.times(100)}%`, outputVat, 'info'),
        line('IVA dedutível (compras)', `${money(compras)} × ${rate.times(100)}%`, inputVat, 'credit'),
        line('IVA a pagar', 'IVA liquidado − IVA dedutível (mínimo 0)', payable, 'total'),
      ];
    },
  },
  {
    code: 'IRPS_RETENCAO',
    title: 'IRPS — Retenções',
    category: 'FISCAL',
    description: 'Calcula a retenção mensal de IRPS sobre rendimentos do trabalho dependente.',
    ruleCodes: ['IRPS_BRACKETS', 'INSS_RATES'],
    inputs: [{ name: 'salarioBruto', label: 'Remuneração mensal bruta (MZN)', type: 'money', min: 0 }],
    compute: async (inputs, { rule }) => {
      const brackets = contentBrackets((await rule('IRPS_BRACKETS')).content, 'monthlyBrackets', 'rate');
      const inssEmployee = contentNumber((await rule('INSS_RATES')).content, 'employeeRate');
      const bruto = inputs.salarioBruto as Decimal;
      const inss = bruto.times(inssEmployee);
      const base = bruto.minus(inss);
      const irps = progressive(base, brackets);
      return [
        line('Contribuição INSS do trabalhador', `${money(bruto)} × ${inssEmployee.times(100)}%`, inss, 'credit'),
        line('Base de incidência IRPS', 'Bruto − INSS do trabalhador', base, 'info'),
        line('IRPS a reter', 'Escalões mensais aprovados', irps, 'total'),
      ];
    },
  },
  {
    code: 'IRPC_ESTIMATIVA',
    title: 'IRPC — Estimativa',
    category: 'FISCAL',
    description: 'Estima o IRPC anual a partir do lucro tributável e do regime aplicável.',
    ruleCodes: ['IRPC_RATE'],
    inputs: [
      { name: 'lucroTributavel', label: 'Lucro tributável estimado (MZN)', type: 'money', min: 0 },
      { name: 'regime', label: 'Regime', type: 'select', options: SELECT_TAX_REGIME },
    ],
    compute: async (inputs, { rule }) => {
      const content = (await rule('IRPC_RATE')).content;
      const regime = inputs.regime as string;
      const rate = regime === 'REDUCED' ? contentNumber(content, 'reducedRate') : contentNumber(content, 'standardRate');
      const lucro = inputs.lucroTributavel as Decimal;
      const irpc = lucro.times(rate);
      return [
        line('Lucro tributável', 'Valor introduzido', lucro, 'info'),
        line(`IRPC (${regime === 'REDUCED' ? 'regime reduzido' : 'regime geral'} — ${rate.times(100)}%)`, `${money(lucro)} × ${rate.times(100)}%`, irpc, 'total'),
      ];
    },
  },
  {
    code: 'INSS',
    title: 'INSS — Contribuições',
    category: 'LABOR',
    description: 'Calcula as contribuições do trabalhador e da entidade patronal para o INSS.',
    ruleCodes: ['INSS_RATES'],
    inputs: [{ name: 'salarioBruto', label: 'Remuneração mensal bruta (MZN)', type: 'money', min: 0 }],
    compute: async (inputs, { rule }) => {
      const content = (await rule('INSS_RATES')).content;
      const employee = contentNumber(content, 'employeeRate');
      const employer = contentNumber(content, 'employerRate');
      const bruto = inputs.salarioBruto as Decimal;
      const employeeContribution = bruto.times(employee);
      const employerContribution = bruto.times(employer);
      return [
        line('Contribuição do trabalhador', `${money(bruto)} × ${employee.times(100)}%`, employeeContribution),
        line('Contribuição da entidade patronal', `${money(bruto)} × ${employer.times(100)}%`, employerContribution),
        line('Total mensal ao INSS', 'Trabalhador + entidade patronal', employeeContribution.plus(employerContribution), 'total'),
      ];
    },
  },
  {
    code: 'SALARIO_LIQUIDO',
    title: 'Salário Líquido',
    category: 'LABOR',
    description: 'Calcula o salário líquido a partir do bruto, INSS e retenção de IRPS.',
    ruleCodes: ['INSS_RATES', 'IRPS_BRACKETS'],
    inputs: [{ name: 'salarioBruto', label: 'Remuneração mensal bruta (MZN)', type: 'money', min: 0 }],
    compute: async (inputs, { rule }) => {
      const inssEmployee = contentNumber((await rule('INSS_RATES')).content, 'employeeRate');
      const brackets = contentBrackets((await rule('IRPS_BRACKETS')).content, 'monthlyBrackets', 'rate');
      const bruto = inputs.salarioBruto as Decimal;
      const inss = bruto.times(inssEmployee);
      const irps = progressive(bruto.minus(inss), brackets);
      const net = bruto.minus(inss).minus(irps);
      return [
        line('Remuneração bruta', 'Valor introduzido', bruto, 'info'),
        line('INSS do trabalhador', `${money(bruto)} × ${inssEmployee.times(100)}%`, inss, 'debit'),
        line('Retenção de IRPS', 'Escalões mensais sobre (bruto − INSS)', irps, 'debit'),
        line('Salário líquido', 'Bruto − INSS − IRPS', net, 'total'),
      ];
    },
  },
  {
    code: 'CUSTO_TRABALHADOR',
    title: 'Custo do Trabalhador',
    category: 'LABOR',
    description: 'Calcula o custo total mensal da entidade patronal por trabalhador.',
    ruleCodes: ['INSS_RATES'],
    inputs: [{ name: 'salarioBruto', label: 'Remuneração mensal bruta (MZN)', type: 'money', min: 0 }],
    compute: async (inputs, { rule }) => {
      const employer = contentNumber((await rule('INSS_RATES')).content, 'employerRate');
      const bruto = inputs.salarioBruto as Decimal;
      const inssEmployer = bruto.times(employer);
      const totalCost = bruto.plus(inssEmployer);
      return [
        line('Remuneração bruta', 'Valor introduzido', bruto, 'info'),
        line('INSS da entidade patronal', `${money(bruto)} × ${employer.times(100)}%`, inssEmployer, 'debit'),
        line('Custo total mensal', 'Bruto + INSS patronal', totalCost, 'total'),
      ];
    },
  },
  {
    code: 'MULTAS_JUROS',
    title: 'Juros e Multas',
    category: 'FINANCE',
    description: 'Calcula juros de mora e multa por pagamento fora do prazo.',
    ruleCodes: ['PENALTY_RATES'],
    inputs: [
      { name: 'principal', label: 'Imposto em atraso (MZN)', type: 'money', min: 0 },
      { name: 'diasAtraso', label: 'Dias de atraso', type: 'integer', min: 1 },
    ],
    compute: async (inputs, { rule }) => {
      const content = (await rule('PENALTY_RATES')).content;
      const annualInterest = contentNumber(content, 'annualInterestRate');
      const fineRate = contentNumber(content, 'fineRate');
      const principal = inputs.principal as Decimal;
      const days = inputs.diasAtraso as Decimal;
      const juros = principal.times(annualInterest).div(365).times(days);
      const multa = principal.times(fineRate);
      return [
        line('Juros de mora', `${money(principal)} × ${annualInterest.times(100)}% ÷ 365 × ${days.toFixed(0)} dias`, juros),
        line('Multa por atraso', `${money(principal)} × ${fineRate.times(100)}%`, multa),
        line('Total a regularizar', 'Juros + multa', juros.plus(multa), 'total'),
      ];
    },
  },
  {
    code: 'NAO_RESIDENTE',
    title: 'Pagamento a Não Residentes',
    category: 'FISCAL',
    description: 'Calcula IVA e retenção na fonte sobre serviços de não residentes, com base majorada.',
    ruleCodes: ['NONRESIDENT_SERVICE'],
    inputs: [
      { name: 'valorFatura', label: 'Valor da fatura (moeda estrangeira)', type: 'money', min: 0 },
      { name: 'cambio', label: 'Câmbio (MZN por unidade)', type: 'money', min: 0 },
    ],
    compute: async (inputs, { rule }) => {
      const content = (await rule('NONRESIDENT_SERVICE')).content;
      const grossUp = contentNumber(content, 'grossUpFactor');
      const vatRate = contentNumber(content, 'vatRate');
      const whtRate = contentNumber(content, 'withholdingRate');
      const invoice = inputs.valorFatura as Decimal;
      const fx = inputs.cambio as Decimal;
      const contraValor = invoice.times(fx);
      const base = contraValor.times(grossUp);
      const iva = base.times(vatRate);
      const retencao = base.times(whtRate);
      return [
        line('Contra-valor em Meticais', `${money(invoice)} × ${money(fx)}`, contraValor, 'info'),
        line('Base majorada (contra-valor × fator)', `${money(contraValor)} × ${grossUp}`, base, 'info'),
        line(`IVA (${vatRate.times(100)}%)`, `${money(base)} × ${vatRate.times(100)}%`, iva),
        line(`Retenção IRPC na fonte (${whtRate.times(100)}%)`, `${money(base)} × ${whtRate.times(100)}%`, retencao),
        line('Total de impostos', 'IVA + retenção', iva.plus(retencao), 'total'),
      ];
    },
  },
  {
    code: 'HORAS_EXTRAS',
    title: 'Horas Extras',
    category: 'LABOR',
    description: 'Calcula o valor de horas extra conforme o tipo de dia.',
    ruleCodes: ['OVERTIME_RATES'],
    inputs: [
      { name: 'valorHora', label: 'Valor da hora normal (MZN)', type: 'money', min: 0 },
      { name: 'horas', label: 'Horas extra', type: 'integer', min: 1 },
      {
        name: 'tipoDia',
        label: 'Tipo de dia',
        type: 'select',
        options: [
          { value: 'WEEKDAY', label: 'Dia útil' },
          { value: 'WEEKEND', label: 'Fim de semana' },
          { value: 'HOLIDAY', label: 'Feriado' },
          { value: 'NIGHT', label: 'Trabalho noturno' },
        ],
      },
    ],
    compute: async (inputs, { rule }) => {
      const content = (await rule('OVERTIME_RATES')).content;
      const tipo = inputs.tipoDia as 'WEEKDAY' | 'WEEKEND' | 'HOLIDAY' | 'NIGHT';
      const field = { WEEKDAY: 'weekday', WEEKEND: 'weekend', HOLIDAY: 'holiday', NIGHT: 'night' }[tipo];
      const multiplier = contentNumber(content, field);
      const valorHora = inputs.valorHora as Decimal;
      const horas = inputs.horas as Decimal;
      const valor = valorHora.times(multiplier).times(horas);
      return [
        line('Valor da hora majorada', `${money(valorHora)} × ${multiplier}`, valorHora.times(multiplier), 'info'),
        line(`Total horas extra (${tipo})`, `${money(valorHora.times(multiplier))} × ${horas.toFixed(0)}h`, valor, 'total'),
      ];
    },
  },
  {
    code: 'FERIAS',
    title: 'Subsídio de Férias',
    category: 'LABOR',
    description: 'Calcula o subsídio de férias proporcional aos meses trabalhados.',
    ruleCodes: ['LEAVE_RULES'],
    inputs: [
      { name: 'salarioMensal', label: 'Remuneração mensal bruta (MZN)', type: 'money', min: 0 },
      { name: 'mesesTrabalhados', label: 'Meses trabalhados no ano', type: 'integer', min: 0, max: 12 },
    ],
    compute: async (inputs, { rule }) => {
      const maxMonths = contentNumber((await rule('LEAVE_RULES')).content, 'maxSubsidyMonths');
      const salario = inputs.salarioMensal as Decimal;
      const meses = inputs.mesesTrabalhados as Decimal;
      const subsidio = salario.times(meses.div(12)).times(maxMonths);
      return [
        line('Proporção do ano', `${meses.toFixed(0)} ÷ 12 meses`, meses.div(12).times(salario), 'info'),
        line('Subsídio de férias proporcional', `${money(salario)} × ${meses.div(12).toDecimalPlaces(4)} × ${maxMonths}`, subsidio, 'total'),
      ];
    },
  },
  {
    code: 'INDEMNIZACAO',
    title: 'Indemnização',
    category: 'LABOR',
    description: 'Calcula a indemnização de cessação de contrato por antiguidade.',
    ruleCodes: ['SEVERANCE_RULES'],
    inputs: [
      { name: 'salarioMensal', label: 'Remuneração mensal bruta (MZN)', type: 'money', min: 0 },
      { name: 'anos', label: 'Anos de serviço', type: 'integer', min: 0 },
      { name: 'meses', label: 'Meses adicionais', type: 'integer', min: 0, max: 11 },
    ],
    compute: async (inputs, { rule }) => {
      const daysPerYear = contentNumber((await rule('SEVERANCE_RULES')).content, 'daysPerYear');
      const salario = inputs.salarioMensal as Decimal;
      const anos = inputs.anos as Decimal;
      const meses = inputs.meses as Decimal;
      const dias = anos.times(daysPerYear).plus(daysPerYear.times(meses.div(12)));
      const valor = salario.times(dias.div(30));
      return [
        line('Dias de indemnização', `${anos.toFixed(0)}a ${meses.toFixed(0)}m × ${daysPerYear} dias/ano`, dias, 'info'),
        line('Indemnização estimada', `${money(salario)} × ${dias.toDecimalPlaces(2)} ÷ 30`, valor, 'total'),
      ];
    },
  },
  {
    code: 'SELO',
    title: 'Imposto do Selo',
    category: 'FISCAL',
    description: 'Calcula o imposto do selo aplicável a vários atos jurídicos.',
    ruleCodes: ['STAMP_DUTY'],
    inputs: [
      { name: 'base', label: 'Base tributável (MZN)', type: 'money', min: 0 },
      {
        name: 'ato',
        label: 'Ato jurídico',
        type: 'select',
        // Option values must mirror the `code` fields of the approved STAMP_DUTY table.
        options: [
          { value: 'COMPRA_VENDA_IMOVEIS', label: 'Compra e venda de imóveis' },
          { value: 'JUROS_EMPRESTIMO', label: 'Juros de empréstimo' },
          { value: 'ARRENDAMENTO', label: 'Arrendamento' },
          { value: 'SEGUROS', label: 'Prémios de seguro' },
        ],
      },
    ],
    compute: async (inputs, { rule }) => {
      const content = (await rule('STAMP_DUTY')).content;
      const table = content.table;
      if (!Array.isArray(table) || table.length === 0) throw new AppError(500, 'RULE_CONTENT_INVALID', "Approved rule content field 'table' must be a non-empty table.");
      const ato = inputs.ato as string;
      const entry = table.find((row) => typeof row === 'object' && row !== null && (row as Record<string, unknown>).code === ato) as Record<string, unknown> | undefined;
      if (!entry || typeof entry.rate !== 'number') throw new AppError(500, 'RULE_CONTENT_INVALID', `Stamp-duty table has no numeric rate for act '${ato}'.`);
      const rate = new Decimal(entry.rate);
      const base = inputs.base as Decimal;
      const imposto = base.times(rate);
      return [
        line('Base tributável', 'Valor introduzido', base, 'info'),
        line(`Imposto do selo (${entry.label ?? ato} — ${rate.times(100)}%)`, `${money(base)} × ${rate.times(100)}%`, imposto, 'total'),
      ];
    },
  },
  {
    code: 'TAE',
    title: 'TAE — Taxa de Actividade Económica',
    category: 'FISCAL',
    description: 'Estima a TAE municipal anual a partir do volume de negócios.',
    ruleCodes: ['TAE_BRACKETS'],
    inputs: [{ name: 'receitaAnual', label: 'Volume de negócios anual (MZN)', type: 'money', min: 0 }],
    compute: async (inputs, { rule }) => {
      const brackets = contentBrackets((await rule('TAE_BRACKETS')).content, 'brackets', 'fixed');
      const receita = inputs.receitaAnual as Decimal;
      const taxa = bracketFixed(receita, brackets);
      return [
        line('Volume de negócios anual', 'Valor introduzido', receita, 'info'),
        line('TAE anual (escalão aplicável)', 'Tabela aprovada', taxa, 'total'),
      ];
    },
  },
];

export function getSimulator(code: string): Simulator | undefined {
  return simulators.find((s) => s.code === code);
}
