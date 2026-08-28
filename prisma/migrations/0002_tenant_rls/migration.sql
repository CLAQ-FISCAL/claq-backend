-- Tenant isolation. Applied after 0001_init by the migration runner (master user).
-- The API sets app.tenant_id once per transaction (src/lib/tenant.ts withTenant).
-- FORCE applies the policies to the table owner too: any query without tenant context returns zero rows (default-deny).

ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Obligation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Simulation" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "Company" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Obligation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "NotificationSetting" FORCE ROW LEVEL SECURITY;
ALTER TABLE "NotificationAttempt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Simulation" FORCE ROW LEVEL SECURITY;

CREATE POLICY company_tenant ON "Company"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY obligation_tenant ON "Obligation"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY audit_tenant ON "AuditEvent"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY notification_setting_tenant ON "NotificationSetting"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY notification_attempt_tenant ON "NotificationAttempt"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY simulation_tenant ON "Simulation"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
