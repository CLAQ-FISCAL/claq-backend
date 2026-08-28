import Decimal from 'decimal.js';
export type Rule = { status: 'DRAFT'|'IN_REVIEW'|'APPROVED'|'RETIRED'; effectiveFrom: string; effectiveTo?: string; formula: string; sourceUrl: string; reviewer?: string };
export function assertApproved(rule: Rule, at: Date): void {
  if (rule.status !== 'APPROVED' || !rule.reviewer || !rule.sourceUrl) throw new Error('Only sourced, reviewed, approved tax rules may calculate customer amounts.');
  if (at < new Date(rule.effectiveFrom) || (rule.effectiveTo && at > new Date(rule.effectiveTo))) throw new Error('Rule is not effective on the selected date.');
}
export function vatEstimate(rule: Rule, output: string, input: string, at = new Date()): string {
  assertApproved(rule, at); // Percentage is supplied by approved rule content; never embedded here.
  return Decimal.max(new Decimal(output).minus(input), 0).toFixed(2);
}
