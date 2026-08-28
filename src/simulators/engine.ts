import Decimal from 'decimal.js';
import { AppError } from '../lib/http';
import type { ApprovedRule } from '../rules';

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });

export type InputType = 'money' | 'integer' | 'select';

export type InputSpec = {
  name: string;
  label: string;
  type: InputType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
};

export type LineKind = 'info' | 'debit' | 'credit' | 'total';

export type Line = { label: string; formula: string; amount: string; kind: LineKind };

export type ResolvedInputs = Record<string, Decimal | string>;

export type RuleLoader = (code: string) => Promise<ApprovedRule>;

export type Simulator = {
  code: string;
  title: string;
  category: 'FISCAL' | 'LABOR' | 'FINANCE';
  description: string;
  ruleCodes: string[];
  inputs: InputSpec[];
  compute: (inputs: ResolvedInputs, ctx: { rule: RuleLoader }) => Promise<Line[]>;
};

export function money(value: Decimal | string | number): string {
  return new Decimal(value).toDecimalPlaces(2).toFixed(2);
}

export function line(label: string, formula: string, amount: Decimal | string | number, kind: LineKind = 'debit'): Line {
  return { label, formula, amount: money(amount), kind };
}

export function parseInputs(sim: Simulator, body: Record<string, unknown>): ResolvedInputs {
  const resolved: ResolvedInputs = {};
  for (const spec of sim.inputs) {
    const raw = body[spec.name];
    if (raw === undefined || raw === null || raw === '') {
      throw new AppError(422, 'INPUT_INVALID', `Missing input '${spec.name}' (${spec.label}).`);
    }
    if (spec.type === 'select') {
      if (typeof raw !== 'string' || !spec.options?.some((o) => o.value === raw)) {
        throw new AppError(422, 'INPUT_INVALID', `Invalid value for '${spec.name}'.`);
      }
      resolved[spec.name] = raw;
      continue;
    }
    let value: Decimal;
    try {
      value = new Decimal(String(raw));
    } catch {
      throw new AppError(422, 'INPUT_INVALID', `Input '${spec.name}' must be a number.`);
    }
    if (!value.isFinite() || value.isNegative()) throw new AppError(422, 'INPUT_INVALID', `Input '${spec.name}' must be a non-negative finite number.`);
    if (spec.min !== undefined && value.lessThan(spec.min)) throw new AppError(422, 'INPUT_INVALID', `Input '${spec.name}' must be >= ${spec.min}.`);
    if (spec.max !== undefined && value.greaterThan(spec.max)) throw new AppError(422, 'INPUT_INVALID', `Input '${spec.name}' must be <= ${spec.max}.`);
    resolved[spec.name] = spec.type === 'integer' ? value.toDecimalPlaces(0) : value;
  }
  return resolved;
}

export type SimRunResult = {
  lines: Line[];
  total: string;
  ruleVersions: { code: string; version: string }[];
};

export async function runSimulator(sim: Simulator, inputs: ResolvedInputs, ruleLoader: RuleLoader): Promise<SimRunResult> {
  const ruleVersions: { code: string; version: string }[] = [];
  const seen = new Set<string>();
  const rule: RuleLoader = async (code) => {
    const loaded = await ruleLoader(code);
    if (!seen.has(code)) {
      seen.add(code);
      ruleVersions.push({ code: loaded.code, version: loaded.version });
    }
    return loaded;
  };
  const lines = await sim.compute(inputs, { rule });
  const totalLines = lines.filter((l) => l.kind === 'total');
  let total: Decimal;
  if (totalLines.length > 0) {
    total = totalLines.reduce((acc, l) => acc.plus(l.amount), new Decimal(0));
  } else {
    const debits = lines.filter((l) => l.kind === 'debit').reduce((acc, l) => acc.plus(l.amount), new Decimal(0));
    const credits = lines.filter((l) => l.kind === 'credit').reduce((acc, l) => acc.plus(l.amount), new Decimal(0));
    total = debits.minus(credits);
  }
  return { lines, total: money(total), ruleVersions };
}
