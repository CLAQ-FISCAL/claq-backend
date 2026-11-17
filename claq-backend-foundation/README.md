# CLAQ Fiscal Alert backend foundation

> **Retired scaffold — do not deploy.** The active backend is maintained in `CLAQ-FISCAL/CLAQ-FISCAL-WEB/backend`. This nested copy is kept as historical reference only and has no deployment workflow.

This is a safe, repeatable AWS backend foundation for the `CLAQ-FISCAL/claq-backend` repository. It has two completely separate environments:

- **demo**: investor/test environment. Synthetic data only, low-cost configuration, automatically identifiable as `DEMO`.
- **prod**: customer environment. Protected database, deletion protection, longer backups and manual GitHub approval required.

Do **not** deploy production until you have an AWS account, a domain, legal/tax-approved rule data and an accountant’s review. This application tracks compliance; it does not submit tax returns to AT and does not put tax rates/deadlines in source code.

## What this foundation gives you

- API Gateway with Cognito JWT authentication
- AWS Lambda API, scheduled reminder worker and separate PDF-job queue
- Private PostgreSQL database (RDS/Aurora-ready) with tenant IDs and row-level-security migration
- Private encrypted S3 document store and safe pre-signed uploads
- CloudTrail, GuardDuty, Security Hub, WAF, encryption, audit-event database and monitoring hooks
- CDK infrastructure-as-code and GitHub Actions using short-lived OpenID Connect credentials
- Example API endpoints, database schema and an approved-rules-only guard

## Repository layout

```text
claq-backend/
  src/                         # Lambda API/worker TypeScript
  prisma/                       # PostgreSQL schema and migrations
  infra/                        # AWS CDK stacks; only place cloud resources are declared
  config/demo.json              # demo values—no secrets
  config/prod.json              # production guardrails—no secrets
  docs/{RUNBOOK.md,API.md,SECURITY.md,TAX-CONTENT.md}
  .github/workflows/{verify.yml,deploy.yml}
```

## Historical reference

This scaffold is retired. Its deployment instructions are intentionally removed; do not
run CDK from this directory. Use only `CLAQ-FISCAL/CLAQ-FISCAL-WEB/backend` for deploys.

## Non-negotiable guardrails

- Use fake names/NUITs and amounts in demo. Never copy production data into it.
- Tax rules must have an official source, effective dates, an accountant reviewer and `APPROVED` state. The sample rule is deliberately `DRAFT`.
- Every table that belongs to a tenant requires `tenant_id` plus RLS. The app derives tenant membership server-side from the authenticated user; it never trusts a frontend-provided company or tenant identifier.
- Keep documents private; use short-lived upload/download URLs and malware scanning before use.
- Investor/demo is not an official tax calculation, filing, payment, or WhatsApp consent proof.
