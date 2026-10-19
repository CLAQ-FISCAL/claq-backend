-- Global (non-tenant) regulatory monitoring tables. No RLS: these are public
-- reference data shared across all tenants, mirroring "RuleSet".

-- CreateTable: RegulatorySource
CREATE TABLE "RegulatorySource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT 'MZ',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegulatorySource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegulatorySource_key_key" ON "RegulatorySource"("key");

-- CreateTable: SourceDocument
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "url" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "rawKey" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SourceDocument_sourceId_externalId_key" ON "SourceDocument"("sourceId", "externalId");
CREATE INDEX "SourceDocument_sourceId_publishedAt_idx" ON "SourceDocument"("sourceId", "publishedAt");
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "RegulatorySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: RegulatoryUpdate
CREATE TABLE "RegulatoryUpdate" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "url" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'NEWS',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "affectedRuleCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "candidateRuleSetId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegulatoryUpdate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RegulatoryUpdate_status_detectedAt_idx" ON "RegulatoryUpdate"("status", "detectedAt");
CREATE INDEX "RegulatoryUpdate_category_publishedAt_idx" ON "RegulatoryUpdate"("category", "publishedAt");
ALTER TABLE "RegulatoryUpdate" ADD CONSTRAINT "RegulatoryUpdate_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SourceDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
