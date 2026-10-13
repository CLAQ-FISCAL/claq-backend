import { createHash } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

type SeedEvent = CloudFormationCustomResourceEvent & {
  ResourceProperties: { SecretArn: string; SeedKey: string; DemoSub: string; DemoEmail: string; DemoDisplayName: string };
};

/**
 * DEMO ONLY — idempotent synthetic bootstrap. Enabled exclusively for the demo stage
 * (see config/demo.json demoSeed.*) so prod can never execute it. Runs as the RDS master
 * user over SSL and sets app.tenant_id so the FORCE RLS policies (0002) accept company rows.
 * All ids are md5-derived and deterministic; re-running is a no-op.
 */
export const handler = async (event: SeedEvent): Promise<{ PhysicalResourceId?: string; Data?: Record<string, unknown> }> => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const { SecretArn, SeedKey, DemoSub, DemoEmail, DemoDisplayName } = event.ResourceProperties;

  const stableId = (label: string): string => createHash('md5').update(label).digest('hex');

  const companies = [
    { id: stableId(`claq-demo:${SeedKey}:company:abc`), legalName: 'ABC Comércio, Lda (SYNTHETIC)', municipality: 'Maputo Cidade', taxRegime: 'IVA_GENERAL', annualRevenueMzn: 900_000 },
    { id: stableId(`claq-demo:${SeedKey}:company:softserv`), legalName: 'SoftServ Moçambique, Lda (SYNTHETIC)', municipality: 'Matola', taxRegime: 'IVA_GENERAL', annualRevenueMzn: 12_000_000 },
  ];

  const secrets = new SecretsManagerClient({});
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: SecretArn }));
  if (!secret.SecretString) throw new Error('Database secret has no SecretString');
  const credentials = JSON.parse(secret.SecretString) as { username: string; password: string; host: string; port: number; dbname?: string };

  const client = new Client({
    host: credentials.host,
    port: credentials.port,
    user: credentials.username,
    password: credentials.password,
    database: credentials.dbname ?? 'postgres',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let tenantId: string;
  let userId: string;
  try {
    await client.query('BEGIN');
    try {
      // Reuse an existing demo tenant/profile when present (e.g. a prior seed.ts run) so
      // ids/rows never duplicate; otherwise create deterministically.
      const tenantRow = await client.query(`SELECT "id" FROM "Tenant" WHERE "name" = 'CLAQ DEMO (ESCRITÓRIO DE CONTABILIDADE)' LIMIT 1`);
      tenantId = tenantRow.rowCount ? tenantRow.rows[0].id : stableId(`claq-demo:${SeedKey}:tenant`);
      if (!tenantRow.rowCount) {
        await client.query(
          `INSERT INTO "Tenant" ("id", "name", "type", "plan") VALUES ($1, 'CLAQ DEMO (ESCRITÓRIO DE CONTABILIDADE)', 'ACCOUNTANT', 'ACCOUNTANT_PREMIUM')`,
          [tenantId],
        );
      }
      await client.query(`UPDATE "Tenant" SET "type" = 'ACCOUNTANT', "plan" = 'ACCOUNTANT_PREMIUM' WHERE "id" = $1`, [tenantId]);
      const userIdRow = await client.query(
        `INSERT INTO "User" ("id", "cognitoSub", "email", "displayName") VALUES ($1, $2, $3, $4)
         ON CONFLICT ("cognitoSub") DO UPDATE SET "email" = EXCLUDED."email", "displayName" = EXCLUDED."displayName"
         RETURNING "id"`,
        [stableId(`claq-demo:${SeedKey}:user:${DemoSub}`), DemoSub, DemoEmail, DemoDisplayName],
      );
      userId = userIdRow.rows[0].id;
      await client.query(
        `INSERT INTO "Membership" ("tenantId", "userId", "role") VALUES ($1, $2, 'OWNER')
         ON CONFLICT ("tenantId", "userId") DO UPDATE SET "role" = 'OWNER'`,
        [tenantId, userId],
      );

      // RLS (0002) scopes tenant rows to app.tenant_id — set it before reading/writing companies/settings.
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      for (const company of companies) {
        const existing = await client.query(`SELECT "id" FROM "Company" WHERE "tenantId" = $1 AND "legalName" = $2 LIMIT 1`, [tenantId, company.legalName]);
        const companyId: string = existing.rowCount ? existing.rows[0].id : company.id;
        await client.query(
          `INSERT INTO "Company" ("id", "tenantId", "legalName", "municipality", "taxRegime", "annualRevenueMzn")
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT ("id") DO UPDATE SET
             "legalName" = EXCLUDED."legalName", "municipality" = EXCLUDED."municipality",
             "taxRegime" = EXCLUDED."taxRegime", "annualRevenueMzn" = EXCLUDED."annualRevenueMzn"`,
          [companyId, tenantId, company.legalName, company.municipality, company.taxRegime, company.annualRevenueMzn],
        );
      }

      for (const channel of ['EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP'] as const) {
        const enabled = channel === 'EMAIL';
        await client.query(
          `INSERT INTO "NotificationSetting" ("id", "tenantId", "channel", "enabled") VALUES ($1, $2, $3, $4)
           ON CONFLICT ("tenantId", "channel") DO UPDATE SET "enabled" = EXCLUDED."enabled"`,
          [stableId(`claq-demo:${SeedKey}:ns:${channel}`), tenantId, channel, enabled],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return {
      PhysicalResourceId: `claq-demo-seed-${SeedKey}`,
      Data: { TenantId: tenantId, UserId: userId, CompanyCount: companies.length },
    };
  } finally {
    await client.end();
  }
};