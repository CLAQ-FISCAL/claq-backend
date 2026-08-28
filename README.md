# CLAQ Fiscal Alert backend

Backend for the CLAQ Fiscal Alert product (tax compliance, obligations, simulators and
alerts for Mozambique). Two completely separate environments:

- **demo**: investor/test environment. Synthetic data only, low-cost configuration, demo banner on.
- **prod**: customer environment. Multi-AZ database, deletion protection, 35-day backups, GitHub approval gate.

This application tracks compliance and estimates taxes; it does **not** submit returns to
AT and never embeds tax rates or deadlines in source code — all fiscal content lives in
reviewed `RuleSet` rows (see `docs/TAX-CONTENT.md`).

## What is implemented

- **Infrastructure (CDK)**: VPC (public/app/isolated-db subnets, NAT), RDS PostgreSQL 16
  encrypted with a rotating KMS CMK, Secrets Manager credentials, SQS notifications queue
  + DLQ, S3 documents bucket (private, versioned, SSL-enforced), Cognito user pool
  (admin-created users, optional TOTP MFA), API Gateway HTTP API with Cognito JWT authorizer
- **Security**: WAF (rate limiting + AWS managed rules), CloudTrail (multi-region management trail), GuardDuty (threat detection), Security Hub (compliance dashboard)
- **Subscription plans**: Two tiers enforced server-side — `ACCOUNTANT_OFFICE` (100 companies, 10 users, all simulators, all channels) and `PME_CORPORATE` (3 companies, 3 users, 7 core simulators, email + in-app only). `GET /v1/subscription` returns limits + usage.
- **SSO**: Google, Microsoft (Azure AD) and Apple federated login via Cognito (configured per-stage in config/*.json).
- **WhatsApp**: Meta Cloud API integration for obligation reminders (via Secrets Manager).
- **Billing**: Stripe subscription management with webhook receiver, invoice tracking, plan syncing.
- **Database migrations**: SQL under `prisma/migrations` applied by a Lambda custom
  resource on every deploy; tenant tables protected by `FORCE ROW LEVEL SECURITY` with
  `app.tenant_id` set per transaction (`withTenant`)
- **HTTP API** (`src/router.ts`): me/tenants, dashboard, obligations (list/patch/generate),
  calendar, companies (NUIT sealed with KMS, reveal audited), simulators, simulation
  history, rule transparency, notification settings — see `docs/API.md`
- **Reminder pipeline**: EventBridge daily cron → planner Lambda (status sync
  UPCOMING→DUE→OVERDUE, per-tenant lead-day dedup) → SQS → SES email Lambda with batch
  failure reporting
- **Simulator engine**: 13 simulators (IVA, IRPS retention, IRPC, INSS, net salary,
  employer cost, penalties, non-resident services, overtime, leave, severance, stamp
  duty, TAE) — every number computed from **APPROVED** rule content only, with Decimal
  math and full calculation breakdowns
- **CI/CD**: `verify` workflow (lint, typecheck, tests, synth) and OIDC-based `deploy`
  workflow with GitHub environments (`demo`, `prod` requires reviewers)

## Repository layout

```text
claq-backend/
  src/                 # API router, domain logic, simulators, workers (TypeScript)
  prisma/              # schema.prisma + SQL migrations + synthetic demo seed
  infra/               # CDK app/stack/foundation — the only place cloud resources are declared
  config/              # demo.json / prod.json guardrails (no secrets)
  scripts/             # esbuild lambda bundler
  test/                # vitest: rules guard, simulators, generator, planner, router
  docs/                # API.md, TAX-CONTENT.md, RUNBOOK.md, SECURITY.md
  .github/workflows/   # verify.yml, deploy.yml
```

## Commands

```powershell
npm install          # postinstall runs prisma generate
npm run lint
npm test
npm run synth -- --context env=demo
npm run deploy:demo
npm run seed:demo    # after first deploy; needs DATABASE_URL (see docs/RUNBOOK.md)
```

## First-time deployment

Follow `docs/RUNBOOK.md` in order (bootstrap → deploy → seed → create Cognito users →
bind membership → hand the frontend exactly `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`,
`API_BASE_URL`). The first deploy creates the database and runs migrations automatically.

## Non-negotiable guardrails

- Use fake names/NUITs and amounts in demo. Never copy production data into it.
- Tax rules must have an official source, effective dates, an accountant reviewer and
  `APPROVED` state. The seed content is deliberately `DRAFT`.
- Every tenant table requires `tenant_id` + RLS. The API derives tenant membership
  server-side from the authenticated user; it never trusts a frontend-provided tenant.
- Documents stay private; short-lived upload/download URLs and malware scanning come
  before any document feature goes live.
- Investor/demo is not an official tax calculation, filing, payment, or WhatsApp consent proof.

## Not yet implemented (required before production)

Push notifications (FCM/APNs), PDF report pipeline, RDS Proxy, external penetration test.
See `docs/SECURITY.md` and `docs/RUNBOOK.md` for the full checklist.
