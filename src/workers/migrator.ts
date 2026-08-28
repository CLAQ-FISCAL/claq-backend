import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

type MigrationEvent = CloudFormationCustomResourceEvent & { ResourceProperties: { SecretArn: string; MigrationHash: string } };

/**
 * Applies each prisma/migrations folder's migration.sql in lexical order, tracked in schema_migrations.
 * Runs as the RDS master user over SSL; DDL only, so FORCE ROW LEVEL SECURITY
 * (which governs tenant data) is not affected.
 */
export const handler = async (event: MigrationEvent): Promise<{ PhysicalResourceId?: string; Data?: Record<string, unknown> }> => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const { SecretArn, MigrationHash } = event.ResourceProperties;
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
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row: { name: string }) => row.name));
    const directory = join(__dirname, 'migrations');
    const files = readdirSync(directory).filter((f) => f.endsWith('.sql') === false).sort();

    const appliedNow: string[] = [];
    for (const folder of files) {
      if (applied.has(folder)) continue;
      const sql = readFileSync(join(directory, folder, 'migration.sql'), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [folder]);
        await client.query('COMMIT');
        appliedNow.push(folder);
        console.log(JSON.stringify({ level: 'info', migration: folder, applied: true }));
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${folder} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { PhysicalResourceId: `claq-migrations-${MigrationHash}`, Data: { Applied: appliedNow, Pending: 0 } };
  } finally {
    await client.end();
  }
};
