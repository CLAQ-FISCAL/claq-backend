# Tax content governance (RuleSet)

**Golden rule: no tax rate, bracket, deadline or formula lives in source code.**
Everything the product computes is data in the `RuleSet` table, and only content that is
sourced, reviewed and `APPROVED` can ever produce a customer-facing number.

## Lifecycle

```
DRAFT ──> IN_REVIEW ──> APPROVED ──> RETIRED
                (accountant review: sourceUrl + reviewer + approvedAt required)
```

- `getApprovedRule(tx, code, at)` picks the approved version effective on the calculation
  date; anything else raises `RULE_NOT_APPROVED` (HTTP 409).
- New versions are added as new rows (`@@unique([code, version])`) — never edit approved content.
- The seed script (`prisma/seed.ts`) loads realistic **DRAFT** content for all rule codes.
  An accountant must review each one, fill `sourceUrl` with the exact diploma URL, set
  `reviewer`/`approvedAt` and flip `status` to `APPROVED` before demo numbers are meaningful.

## Content shapes

### Rate rules (simulators)

| Code | Content |
|---|---|
| `IVA_RATE` | `{ standardRate }` |
| `IRPS_BRACKETS` | `{ monthlyBrackets: [{ upto: number \| null, rate }] }` — progressive; `upto: null` is the top bracket |
| `IRPC_RATE` | `{ standardRate, reducedRate }` |
| `INSS_RATES` | `{ employeeRate, employerRate }` |
| `PENALTY_RATES` | `{ annualInterestRate, fineRate }` — daily interest = annual ÷ 365 |
| `NONRESIDENT_SERVICE` | `{ grossUpFactor, vatRate, withholdingRate }` |
| `OVERTIME_RATES` | `{ weekday, weekend, holiday, night }` — multipliers of the hourly rate |
| `LEAVE_RULES` | `{ maxSubsidyMonths }` |
| `SEVERANCE_RULES` | `{ daysPerYear }` — severance days per year of service |
| `STAMP_DUTY` | `{ table: [{ code, label, rate }] }` — `code` values must mirror the simulator's `ato` select options |
| `TAE_BRACKETS` | `{ brackets: [{ upto: number \| null, fixed }] }` — fixed fee per revenue bracket |

### Obligation templates

```json
{
  "kind": "OBLIGATION_TEMPLATE",
  "title": "IVA — Declaração e Pagamento",
  "category": "TAX",            // TAX | CONTRIBUTION | MUNICIPAL | OTHER
  "periodicity": "MONTHLY",     // or "ANNUAL"
  "dueDay": 15,                 // clamped to month length (31 → Feb 28/29)
  "month": 3                    // ANNUAL only: month 1-12
}
```

`POST /v1/obligations/generate` materialises these into `Obligation` rows per
company/year, idempotently, and records an `OBLIGATIONS_GENERATED` audit event with the
exact rule versions used.

## Review checklist (per rule version)

1. `sourceUrl` points at the official diploma (AT/INSS/municipal) — not a summary site.
2. Effective dates verified (`effectiveFrom`/`effectiveTo`).
3. Numbers cross-checked against at least one worked example (add it to `test/simulators.test.ts`).
4. Reviewer name recorded; `approvedAt` set; status flipped to `APPROVED`.
5. Demo stays identifiable: synthetic data only, `DEMO` plan, demo banner on.

## Known dev-dependency note

The Prisma **CLI** (dev-only, never deployed) currently carries a `deepmerge-ts` stack
exhaustion advisory; the fix requires the Prisma 7+ config migration. Runtime bundles are
clean (`npm audit --omit=dev`). Track the Prisma 7 upgrade as a separate task.
