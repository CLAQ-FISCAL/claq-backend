-- Plan families: ACCOUNTANT (portfolio size) vs COMPANY (Empresas tiers).
-- Tenant.type distinguishes the two dashboards; annualRevenueMzn drives the Empresas tier suggestion.
ALTER TABLE "Tenant" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'ACCOUNTANT';
ALTER TABLE "Tenant" ADD COLUMN "annualRevenueMzn" DECIMAL(18,2);
ALTER TABLE "Company" ADD COLUMN "annualRevenueMzn" DECIMAL(18,2);
ALTER TABLE "Tenant" ALTER COLUMN "plan" SET DEFAULT 'ACCOUNTANT_FREE';

-- Remap legacy plan codes to the new catalogue, preserving prior caps.
UPDATE "Tenant" SET "plan" = 'ACCOUNTANT_PREMIUM' WHERE "plan" = 'ACCOUNTANT_OFFICE';
UPDATE "Tenant" SET "plan" = 'ACCOUNTANT_FREE' WHERE "plan" = 'PME_CORPORATE';
