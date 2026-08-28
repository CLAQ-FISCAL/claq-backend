import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { AppError } from './lib/http';

export type Rule = { status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'RETIRED'; effectiveFrom: string; effectiveTo?: string; formula: string; sourceUrl: string; reviewer?: string };

export function assertApproved(rule: Rule, at: Date): void {
  if (rule.status !== 'APPROVED' || !rule.reviewer || !rule.sourceUrl) throw new Error('Only sourced, reviewed, approved tax rules may calculate customer amounts.');
  if (at < new Date(rule.effectiveFrom) || (rule.effectiveTo && at > new Date(rule.effectiveTo))) throw new Error('Rule is not effective on the selected date.');
}

export function vatEstimate(rule: Rule, output: string, input: string, at = new Date()): string {
  assertApproved(rule, at); // Percentage is supplied by approved rule content; never embedded here.
  return Decimal.max(new Decimal(output).minus(input), 0).toFixed(2);
}

export type RuleContent = Record<string, unknown>;

export type ApprovedRule = {
  code: string;
  version: string;
  content: RuleContent;
  sourceUrl: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

/**
 * Loads the approved rule version effective on `at`. Anything else is rejected:
 * customer amounts may only ever be computed from sourced, reviewed, APPROVED content.
 */
export async function getApprovedRule(tx: Prisma.TransactionClient, code: string, at: Date): Promise<ApprovedRule> {
  const rule = await tx.ruleSet.findFirst({
    where: {
      code,
      status: 'APPROVED',
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!rule) {
    throw new AppError(409, 'RULE_NOT_APPROVED', `No approved '${code}' rule is effective on ${at.toISOString().slice(0, 10)}. Tax content requires an accountant review before it can calculate customer amounts.`);
  }
  return { code: rule.code, version: rule.version, content: rule.content as RuleContent, sourceUrl: rule.sourceUrl, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo };
}

export function contentNumber(content: RuleContent, key: string): Decimal {
  const value = content[key];
  if (typeof value === 'number' && Number.isFinite(value)) return new Decimal(value);
  throw new AppError(500, 'RULE_CONTENT_INVALID', `Approved rule content field '${key}' is missing or not a number.`);
}

export type ContentBracket = { upto: Decimal | null; value: Decimal };

/** Parses bracket tables like [{ "upto": 20999, "rate": 0.10 }, { "upto": null, "rate": 0.25 }] */
export function contentBrackets(content: RuleContent, key: string, valueField: string): ContentBracket[] {
  const raw = content[key];
  if (!Array.isArray(raw) || raw.length === 0) throw new AppError(500, 'RULE_CONTENT_INVALID', `Approved rule content field '${key}' must be a non-empty bracket table.`);
  const brackets: ContentBracket[] = [];
  let previous: Decimal | null = null;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) throw new AppError(500, 'RULE_CONTENT_INVALID', `Bracket entry in '${key}' is not an object.`);
    const record = entry as Record<string, unknown>;
    const uptoRaw = record.upto;
    const value = typeof record[valueField] === 'number' ? new Decimal(record[valueField] as number) : null;
    if (value === null || !Number.isFinite(value.toNumber())) throw new AppError(500, 'RULE_CONTENT_INVALID', `Bracket in '${key}' has no numeric '${valueField}'.`);
    let upto: Decimal | null = null;
    if (typeof uptoRaw === 'number' && Number.isFinite(uptoRaw)) {
      upto = new Decimal(uptoRaw);
      if (previous !== null && upto.lessThanOrEqualTo(previous)) throw new AppError(500, 'RULE_CONTENT_INVALID', `Bracket table '${key}' is not strictly increasing.`);
      previous = upto;
    } else if (uptoRaw !== null) {
      throw new AppError(500, 'RULE_CONTENT_INVALID', `Bracket 'upto' in '${key}' must be a number or null (top bracket).`);
    }
    brackets.push({ upto, value });
  }
  if (brackets[brackets.length - 1].upto !== null) throw new AppError(500, 'RULE_CONTENT_INVALID', `Bracket table '${key}' must end with an open bracket (upto: null).`);
  return brackets;
}

/** Progressive application over bracket tables (tax or fixed fee). */
export function progressive(amount: Decimal | string | number, brackets: ContentBracket[]): Decimal {
  let remaining = new Decimal(amount);
  let lowerBound = new Decimal(0);
  let result = new Decimal(0);
  for (const bracket of brackets) {
    if (remaining.lte(0)) break;
    const slice = bracket.upto === null ? remaining : Decimal.min(remaining, bracket.upto.minus(lowerBound));
    if (slice.lte(0)) break;
    result = result.plus(slice.times(bracket.value));
    remaining = remaining.minus(slice);
    if (bracket.upto === null) break;
    lowerBound = bracket.upto;
  }
  return result;
}
