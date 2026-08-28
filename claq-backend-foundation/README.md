# CLAQ Fiscal Alert backend foundation

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

## First-time deployment: follow in this order

1. Create separate AWS accounts named `claq-demo` and `claq-prod` (best), or use separate `demo` and `prod` stacks while the account split is being arranged. Enable MFA on the root user, do not create routine access keys, and enable AWS IAM Identity Center.
2. Install Node.js 22 LTS, AWS CLI v2 and CDK v2. Sign in to AWS with an Identity Center administrator role—not root.
3. In GitHub, make `claq-backend` **private**. Create GitHub Environments `demo` and `prod`; set required reviewers for `prod`.
4. Copy this foundation into the root of `claq-backend`. Create the `main` branch protection: PR required, two approvals (or one while two-person), status checks `verify`, no direct push, no force push.
5. Create a GitHub OIDC identity provider and one IAM role per environment. Give the demo role access only to demo-tagged stacks; production role only to production-tagged stacks. Store its role ARN in GitHub environment variable `AWS_DEPLOY_ROLE_ARN`.
6. In each AWS account run `cdk bootstrap aws://ACCOUNT/REGION`. Then run `npm ci`, `npm run test`, `npm run synth -- --context env=demo`, and `npm run deploy:demo`. Never deploy with a developer’s permanent access key.
7. Create the Cognito app-client and configure the frontend developer with only `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` and `API_BASE_URL`. Do not put AWS keys, RDS password, KMS keys or backend secrets in Flutter/web code.
8. Set real database secret values only in AWS Secrets Manager. Run the database migration job from the deployment pipeline. Seed only synthetic demo company data in `demo`.
9. Test login, Tenant A/B isolation, an expired JWT, document upload, reminder retry/DLQ and one database restore before an investor demo. Before production, obtain independent penetration testing and tax/legal approval.

## Commands

```powershell
npm ci
npm run lint
npm test
npm run synth -- --context env=demo
npm run deploy:demo
```

The GitHub deployment workflow is deliberately a template: replace `AWS_DEPLOY_ROLE_ARN` with the actual **role ARN**, not a secret. GitHub’s OpenID Connect mechanism removes the need to store AWS access keys in GitHub.

## Non-negotiable guardrails

- Use fake names/NUITs and amounts in demo. Never copy production data into it.
- Tax rules must have an official source, effective dates, an accountant reviewer and `APPROVED` state. The sample rule is deliberately `DRAFT`.
- Every table that belongs to a tenant requires `tenant_id` plus RLS. The app derives tenant membership server-side from the authenticated user; it never trusts a frontend-provided company or tenant identifier.
- Keep documents private; use short-lived upload/download URLs and malware scanning before use.
- Investor/demo is not an official tax calculation, filing, payment, or WhatsApp consent proof.
