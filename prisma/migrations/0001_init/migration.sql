-- Initial schema. Hand-maintained to mirror prisma/schema.prisma (see docs/TAX-CONTENT.md).
-- Applied by the migration-runner Lambda as the RDS master user; tenant tables are RLS-protected (0002).

CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'ACCOUNTANT', 'STAFF', 'VIEWER');
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'RETIRED');
CREATE TYPE "ObligationStatus" AS ENUM ('UPCOMING', 'DUE', 'OVERDUE', 'PAID', 'SUBMITTED', 'NOT_APPLICABLE');
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'DEMO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "cognitoSub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("tenantId", "userId")
);

CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "nuitCiphertext" BYTEA,
    "municipality" TEXT,
    "taxRegime" TEXT,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RuleSet" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "RuleStatus" NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "content" JSONB NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "reviewer" TEXT,
    "approvedAt" TIMESTAMP(3),
    CONSTRAINT "RuleSet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Obligation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'UPCOMING',
    "ruleVersion" TEXT NOT NULL,
    "sourceSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Obligation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before" JSONB,
    "after" JSONB,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationSetting" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "leadDays" INTEGER[] NOT NULL DEFAULT ARRAY[7, 3, 1, 0]::INTEGER[],
    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationAttempt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "leadDay" INTEGER NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Simulation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyId" TEXT,
    "code" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "breakdown" JSONB NOT NULL,
    "total" TEXT NOT NULL,
    "ruleVersions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Simulation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_cognitoSub_key" ON "User"("cognitoSub");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "RuleSet_code_version_key" ON "RuleSet"("code", "version");
CREATE UNIQUE INDEX "NotificationSetting_tenantId_channel_key" ON "NotificationSetting"("tenantId", "channel");
CREATE UNIQUE INDEX "NotificationAttempt_obligationId_channel_leadDay_key" ON "NotificationAttempt"("obligationId", "channel", "leadDay");
CREATE INDEX "Company_tenantId_idx" ON "Company"("tenantId");
CREATE INDEX "Obligation_tenantId_dueAt_idx" ON "Obligation"("tenantId", "dueAt");
CREATE INDEX "Obligation_tenantId_status_idx" ON "Obligation"("tenantId", "status");
CREATE INDEX "Obligation_dueAt_idx" ON "Obligation"("dueAt");
CREATE INDEX "AuditEvent_tenantId_occurredAt_idx" ON "AuditEvent"("tenantId", "occurredAt");
CREATE INDEX "NotificationAttempt_tenantId_createdAt_idx" ON "NotificationAttempt"("tenantId", "createdAt");
CREATE INDEX "Simulation_tenantId_code_createdAt_idx" ON "Simulation"("tenantId", "code", "createdAt");

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Company" ADD CONSTRAINT "Company_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationSetting" ADD CONSTRAINT "NotificationSetting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationAttempt" ADD CONSTRAINT "NotificationAttempt_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Simulation" ADD CONSTRAINT "Simulation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
