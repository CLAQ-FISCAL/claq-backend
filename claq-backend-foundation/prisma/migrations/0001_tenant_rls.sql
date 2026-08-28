-- Apply after Prisma's initial migration. API connections must set app.tenant_id once per transaction.
alter table "Company" enable row level security;
alter table "Obligation" enable row level security;
alter table "AuditEvent" enable row level security;
create policy company_tenant on "Company" using ("tenantId" = current_setting('app.tenant_id', true));
create policy obligation_tenant on "Obligation" using ("tenantId" = current_setting('app.tenant_id', true));
create policy audit_tenant on "AuditEvent" using ("tenantId" = current_setting('app.tenant_id', true));
