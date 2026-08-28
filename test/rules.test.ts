import { describe, expect, it } from 'vitest';
import { assertApproved, contentBrackets, progressive, vatEstimate, type Rule } from '../src/rules';

const approved: Rule = {
  status: 'APPROVED',
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: '2026-12-31T23:59:59Z',
  formula: 'max(output - input, 0)',
  sourceUrl: 'https://www.at.gov.mz/example',
  reviewer: 'Contabilista Aprovado',
};

describe('assertApproved', () => {
  it('accepts a sourced, reviewed, approved rule inside its window', () => {
    expect(() => assertApproved(approved, new Date('2026-06-15T00:00:00Z'))).not.toThrow();
  });

  it('rejects draft rules', () => {
    expect(() => assertApproved({ ...approved, status: 'DRAFT' }, new Date())).toThrow(/approved/i);
  });

  it('rejects approvals without a reviewer or source', () => {
    expect(() => assertApproved({ ...approved, reviewer: undefined }, new Date())).toThrow(/approved/i);
    expect(() => assertApproved({ ...approved, sourceUrl: '' }, new Date())).toThrow(/approved/i);
  });

  it('rejects dates outside the effective window', () => {
    expect(() => assertApproved(approved, new Date('2027-01-01T00:00:00Z'))).toThrow(/effective/i);
    expect(() => assertApproved(approved, new Date('2025-12-31T00:00:00Z'))).toThrow(/effective/i);
  });
});

describe('vatEstimate', () => {
  it('computes output minus input, floored at zero', () => {
    expect(vatEstimate(approved, '1000.00', '400.00', new Date('2026-06-01T00:00:00Z'))).toBe('600.00');
    expect(vatEstimate(approved, '100.00', '400.00', new Date('2026-06-01T00:00:00Z'))).toBe('0.00');
  });

  it('refuses unapproved rules', () => {
    expect(() => vatEstimate({ ...approved, status: 'IN_REVIEW' }, '100', '0')).toThrow(/approved/i);
  });
});

describe('progressive brackets', () => {
  const brackets = contentBrackets(
    {
      monthlyBrackets: [
        { upto: 20999, rate: 0.1 },
        { upto: 49999, rate: 0.15 },
        { upto: 149999, rate: 0.2 },
        { upto: null, rate: 0.25 },
      ],
    },
    'monthlyBrackets',
    'rate',
  );

  it('applies each rate to its slice', () => {
    // 48,500 base: 20,999 × 10% + 27,501 × 15% = 2,099.90 + 4,125.15
    expect(progressive('48500', brackets).toFixed(2)).toBe('6225.05');
  });

  it('reaches the top bracket', () => {
    // 200,000: 20,999×10% + 29,000×15% + 100,000×20% + 50,001×25% = 38,950.15
    expect(progressive('200000', brackets).toFixed(2)).toBe('38950.15');
  });

  it('rejects malformed bracket tables', () => {
    expect(() => contentBrackets({ b: [] }, 'b', 'rate')).toThrow();
    expect(() => contentBrackets({ b: [{ upto: 100, rate: 0.1 }, { upto: 100, rate: 0.2 }, { upto: null, rate: 0.2 }] }, 'b', 'rate')).toThrow(/increasing/i);
    expect(() => contentBrackets({ b: [{ upto: 100, rate: 0.1 }] }, 'b', 'rate')).toThrow(/open bracket/i);
    expect(() => contentBrackets({ b: [{ upto: 100 }, { upto: null, rate: 0.2 }] }, 'b', 'rate')).toThrow();
  });
});
