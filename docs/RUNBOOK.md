# Runbook — CLAQ Fiscal Alert backend

## What is deployed (per stage `demo` / `prod`)

- VPC (2 AZs): public subnets + NAT (`1` demo, `2` prod), `app` subnets (Lambda), `db` subnets (isolated, RDS only)
- RDS PostgreSQL 16 (`db.t4g.micro` demo / `db.t4g.large` Multi-AZ prod), encrypted with the `claq-<stage>-data` KMS key, credentials in Secrets Manager
- Migration runner Lambda invoked as a `Custom::ClaqDatabaseMigration` custom resource on every deploy
- API Lambda (Prisma, RLS-guarded) behind API Gateway HTTP API with the Cognito JWT authorizer
- Reminders Lambda on `cron(0 6 * * ? *)` → Notifications SQS queue (DLQ ×3) → Notifier Lambda → SES email
- Cognito user pool (admin-create-user only, optional TOTP MFA, 12+ char passwords)
- Encrypted, versioned, SSL-enforced S3 documents bucket + CloudTrail logs bucket
- **WAF**: rate limiting (2000 req/5min/IP) + AWS managed rules (CommonRuleSet, SQLi)
- **CloudTrail**: multi-region management trail, CloudWatch Logs integration, 365-day retention (prod)
- **GuardDuty**: always-on threat detection, 15-minute finding frequency
- **Security Hub**: auto-enabled controls, compliance dashboard

First deploy takes ~15–20 minutes (RDS creation). Subsequent deploys are minutes.

## Commands

```powershell
npm ci                      # postinstall runs prisma generate
npm run lint                # eslint (src, infra, scripts)
npm test                    # vitest
npm run synth -- --context env=demo
npm run deploy:demo         # builds lambdas + cdk deploy (demo)
npm run deploy:prod         # requires GitHub prod environment approval in CI
```

## First-time setup (per AWS account)

1. `cdk bootstrap aws://ACCOUNT/REGION` (Identity Center role, never root).
2. `npm run deploy:demo` — creates VPC, RDS, Cognito, queues, API, WAF, CloudTrail, GuardDuty, Security Hub.
3. Seed the demo database (synthetic data only):
   ```powershell
   $env:DATABASE_URL = "postgresql://claq_admin:<password>@<endpoint>:5432/claq?sslmode=require"
   npm run seed:demo
   ```
   Get `<password>` from Secrets Manager (`DatabaseSecretArn` output). The connection must
   run from inside the VPC (bastion, SSM session port-forward, or CloudShell in-VPC).
4. Create demo users: `aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true`.
5. Bind the Cognito user to the seeded membership (one-off SQL from step 3's session):
   ```sql
   UPDATE "User" SET "cognitoSub" = '<cognito-sub>' WHERE email = 'demo-admin@claq.co.mz';
   ```
6. Give the frontend partner exactly three values: `COGNITO_USER_POOL_ID`,
   `COGNITO_CLIENT_ID`, `API_BASE_URL` (stack outputs). Nothing else.

### SSO setup (optional, per stage)

1. Fill the OAuth credentials in `config/<stage>.json` (`googleClientId`/`googleClientSecret`, etc.).
2. Create callback URLs in each provider console pointing at the Cognito hosted UI authorize URL.
3. Redeploy — the identity providers are created automatically when credentials are present.
4. Users can now sign in via the Cognito hosted UI or the SDK hosted UI component.

### WhatsApp setup (optional)

1. Create a Meta Business WhatsApp Cloud API app, get a Phone Number ID + permanent access token.
2. Store in Secrets Manager:
   ```json
   { "phoneNumberId": "1234567890", "accessToken": "EAAB..." }
   ```
3. Set `whatsappSecretArn` in `config/<stage>.json` to the secret ARN.
4. Users set their `phone` field (E.164, digits only, e.g. `258841234567`) to receive WhatsApp reminders.

### Stripe billing setup (optional)

1. Create a Stripe account, create Products + Prices for each plan (ACCOUNTANT_OFFICE, PME_CORPORATE).
2. Set environment variables on the API Lambda: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_ACCOUNTANT_OFFICE`, `STRIPE_PRICE_PME_CORPORATE`.
3. Register a webhook in Stripe dashboard → endpoint `POST <API_URL>/v1/billing/webhook` →
   events: `customer.subscription.*`, `invoice.*`.
4. Create a Checkout Session or Customer Portal in the frontend to collect payments.

## Email (SES)

The Notifier sends from `alertsFromEmail` (config/<stage>.json). Until the sending
identity is verified, SES stays in sandbox mode: reminders are planned and queued, sends
fail with a logged reason and the `NotificationAttempt` row is marked `FAILED` — nothing
crashes. To go live: verify the domain in SES (both accounts), request production access,
then tighten the `ses:SendEmail` IAM statement from `*` to the identity ARN (TODO marker
in `infra/stack.ts`).

## Migrations

- SQL lives in `prisma/migrations/<n>_<name>/migration.sql`, hand-maintained to mirror
  `prisma/schema.prisma`. The runner applies pending folders in lexical order, tracked in
  `schema_migrations`; the deploy re-runs it automatically when the content hash changes.
- DDL runs as master. Tenant tables use `FORCE ROW LEVEL SECURITY`: any query without
  `app.tenant_id` set returns zero rows / is rejected. Application access always goes
  through `withTenant()` (`src/lib/tenant.ts`).
- To add a migration: create the folder + `migration.sql`, mirror the change in
  `schema.prisma`, run `npx prisma generate`, deploy.

## Operations

- **Queue depth / DLQ**: alarm on `Notifications` `ApproximateNumberOfMessagesVisible`
  and anything arriving in `NotificationsDlq` (3 failed sends). Redrive after fixing.
- **Reminder run**: CloudWatch log group `/aws/lambda/claq-<stage>-RemindersFunction…`
  logs `{ tenants, statusChanges, planned, enqueued }` daily.
- **Audit trail**: `AuditEvent` rows (company created, obligation status changes, NUIT
  reveals, generation runs) are tenant-scoped and queryable.
- **Restore drill**: before investor demos, restore `claq` from a snapshot into a temp
  instance and verify row counts (README guardrail).

## Known limitations / follow-ups

- Prisma CLI dev-advisory (deepmerge-ts) — requires Prisma 7 config migration (see TAX-CONTENT.md).
- No SSO (Google/Microsoft/Apple), WhatsApp/push channels, billing/plans, or PDF job pipeline yet.
- Prisma connects directly to RDS (`connection_limit=1`); add RDS Proxy before high concurrency.
- `sslmode=require` + `rejectUnauthorized:false` in the migrator: switch to the RDS CA
  bundle for certificate validation hardening.
