# CLAQ Fiscal Alert — API reference

Base URL: the `ApiUrl` CloudFormation output (API Gateway HTTP API, `$default` stage).
All routes require a Cognito JWT: `Authorization: Bearer <token>`. Tokens are verified
by the API Gateway JWT authorizer before the Lambda runs.

## Multi-tenancy

The working tenant is resolved **server-side** from the Membership table — a tenant id
from the client is only a selector, never an authorization:

- If the user belongs to exactly one tenant, it is used automatically.
- If the user belongs to several (e.g. an accountant with multiple clients), requests
  must send `X-Tenant-Id: <tenantId>`; otherwise `400 TENANT_REQUIRED` is returned.
- Requesting a tenant the user does not belong to returns `403 TENANT_ACCESS_DENIED`.

Every tenant-scoped query runs inside a PostgreSQL transaction with `app.tenant_id`
set, enforced by `FORCE ROW LEVEL SECURITY` (see `prisma/migrations/0002_tenant_rls`).

## SSO (federated login)

Google, Microsoft (Azure AD) and Apple sign-in are configured in Cognito and activated
per-stage in `config/<stage>.json` by filling the OAuth client credentials. When the
credentials are absent the provider is simply not created.

The Cognito hosted UI domain is `<domainPrefix>-auth` (e.g. `demo-auth`). The frontend
initiates login by redirecting to:
```
https://<domainPrefix>-auth.auth.<region>.amazoncognito.com/oauth2/authorize?client_id=<CLIENT_ID>&response_type=code&scope=openid+email+profile&redirect_uri=<CALLBACK>
```

- **Google**: create OAuth 2.0 credentials in Google Cloud Console, set `googleClientId` + `googleClientSecret` in config.
- **Microsoft**: register an app in Azure AD, set `microsoftClientId` + `microsoftClientSecret` (+ optional `microsoftTenantId`) in config.
- **Apple**: create a Services ID in Apple Developer, set `appleClientId` + `appleTeamId` + `appleKeyId` + `applePrivateKey` in config.

## Billing (Stripe)

Subscription management via Stripe. Webhook receiver at `POST /v1/billing/webhook`
(verified via `Stripe-Signature` header, no JWT required).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/subscription` | JWT | Current plan + limits + usage |
| GET | `/v1/billing/subscription` | JWT | Stripe subscription details |
| GET | `/v1/billing/invoices` | JWT | Invoice history |
| POST | `/v1/billing/webhook` | **Stripe signature** | Webhook receiver |

Events handled: `customer.subscription.created/updated/deleted`, `invoice.paid/payment_failed`.
Price ↔ plan mapping configured via the `STRIPE_PRICES` JSON env var (`{ "ACCOUNTANT_PRO": "price_...", "COMPANY_PEQUENA": "price_..." }`).
When a subscription is deleted the tenant downgrades to its family default (`ACCOUNTANT_FREE` or `COMPANY_MICRO`).

## Notification channels

| Channel | Transport | Setup |
|---|---|---|
| EMAIL | SES | Verify sending identity in SES sandbox first |
| WHATSAPP | Meta Cloud API | Create `WHATSAPP_SECRET_ARN` in Secrets Manager (`phoneNumberId` + `accessToken`) |
| IN_APP | Frontend polling | Queued, pending frontend integration |
| PUSH | Reserved | Not yet implemented |

## Subscription plans

Two plan families, selected by `Tenant.type` (`ACCOUNTANT` or `COMPANY`), enforced server-side. `DEMO` is unlimited.

### Accountants (`GET /v1/plans` → `families.ACCOUNTANT`)

| Plan | Companies | Label |
|---|---|---|
| **ACCOUNTANT_FREE** | 3 | Início de Carteira |
| **ACCOUNTANT_PRO** | 20 | Carteira em Crescimento |
| **ACCOUNTANT_PREMIUM** | 60+ (unlimited) | Carteira Alargada / Escritório |

### Companies / Empresas (`GET /v1/plans` → `families.COMPANY`)

Tier suggested from declared annual revenue (`Company.annualRevenueMzn`).

| Plan | Annual revenue (MZN) | Users | Storage | Features |
|---|---|---|---|---|
| **COMPANY_MICRO** | < 2.5 M | 1 | — | fiscal calendar, alerts |
| **COMPANY_PEQUENA** | 2.5 M – 25 M | 3 | 5 GB | + risk score |
| **COMPANY_MEDIA** | 25 M – 100 M | 15 | unlimited | + audit, branches |
| **COMPANY_GRANDE** | > 100 M / group | unlimited | unlimited | + multi-enterprise, multicontribution |

`GET /v1/subscription` returns `plan`, `family`, `tenantType`, `limits` (companies, users, storage, features, channels), and usage.
`GET /v1/plans/suggest?annualRevenueMzn=…` returns the suggested Empresas tier.
Enforcement:
- `POST /v1/companies` returns `403 PLAN_LIMIT_EXCEEDED` when the company cap is reached.
- `POST /v1/simulators/{code}` returns `403 SIMULATOR_NOT_AVAILABLE` when the simulator is not on the plan.
- `PUT /v1/notification-settings/{channel}` returns `403 CHANNEL_NOT_AVAILABLE` when the channel is not on the plan.
- The user cap is reported via `GET /v1/subscription` (`limits.maxUsers` / `usage.users`); it will be enforced once a membership-invite endpoint exists.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/v1/health` | Liveness + `SELECT 1` database ping (503 if degraded) |
| GET | `/v1/me` | Current user + tenant memberships (`{ user, tenants[] }`) |
| GET | `/v1/plans` | Plan catalogue (accountant + company families) and Empresas revenue thresholds |
| GET | `/v1/plans/suggest?annualRevenueMzn=` | Suggested Empresas tier for a declared annual revenue |
| GET | `/v1/subscription` | Current plan, family, tenant type, limits (companies, users, storage, features), usage |
| GET | `/v1/dashboard` | Next obligation, counts, `compliancePct`, upcoming 5 (current year) |
| GET | `/v1/obligations` | List. Query: `status` (CSV), `companyId`, `from`, `to`, `limit` (≤500), `offset` |
| PATCH | `/v1/obligations/{id}` | Body `{"status": "PAID" \| "SUBMITTED" \| "NOT_APPLICABLE" \| "UPCOMING"}`. `DUE`/`OVERDUE` are owned by the daily sync |
| POST | `/v1/obligations/generate` | Body `{"companyId", "year"}`. Materialises obligations from **APPROVED** obligation-template rules. Idempotent |
| GET | `/v1/calendar?month=YYYY-MM` | Obligations grouped by ISO day |
| GET | `/v1/companies` | List (NUIT masked, `hasNuit` flag, `annualRevenueMzn`, `suggestedCompanyPlan`) |
| POST | `/v1/companies` | Body `{"legalName", "nuit?" (9 digits), "municipality?", "taxRegime?", "annualRevenueMzn?"}`. NUIT is encrypted with KMS before storage |
| GET | `/v1/companies/{id}` | Single company; `?revealNuit=true` decrypts the NUIT and writes a `NUIT_REVEALED` audit event. Includes `annualRevenueMzn` + `suggestedCompanyPlan` |
| GET | `/v1/simulators` | Simulator registry: codes, inputs metadata, rule codes |
| POST | `/v1/simulators/{code}` | Body `{"inputs": {...}, "companyId?", "at?" (ISO date)}`. Runs the simulator against **APPROVED** rules, saves and returns the breakdown |
| GET | `/v1/simulations` | History. Query: `code`, `limit` (≤200) |
| GET | `/v1/rules/{code}` | Latest rule version for transparency screens (Base Legal). Includes `approvedNow` flag |
| GET | `/v1/notification-settings` | Per-channel settings (EMAIL/PUSH/WHATSAPP/IN_APP) |
| PUT | `/v1/notification-settings/{channel}` | Body `{"enabled", "leadDays": [7,3,1,0]}` (integers 0–30, max 8) |

## Simulators

`IVA`, `IRPS_RETENCAO`, `IRPC_ESTIMATIVA`, `INSS`, `SALARIO_LIQUIDO`, `CUSTO_TRABALHADOR`,
`MULTAS_JUROS`, `NAO_RESIDENTE`, `HORAS_EXTRAS`, `FERIAS`, `INDEMNIZACAO`, `SELO`, `TAE`.

All rates/brackets come from approved `RuleSet` content (never source code). A request
whose rule has no approved, effective version fails with:

```json
{ "code": "RULE_NOT_APPROVED", "status": 409 }
```

Responses include `ruleVersions` so the frontend can render the "Base Legal" panel and
PDF reports can cite exact versions.

## Error envelope

```json
{ "code": "MACHINE_CODE", "message": "Human readable", "requestId": "…" }
```

`400 INVALID_JSON`, `401 UNAUTHENTICATED`, `403 NO_TENANT`, `403 TENANT_ACCESS_DENIED`,
`404 NOT_FOUND`, `409 RULE_NOT_APPROVED`, `422 INPUT_INVALID`, `500 INTERNAL`,
`503` (health degraded). Every response carries `x-request-id`.
