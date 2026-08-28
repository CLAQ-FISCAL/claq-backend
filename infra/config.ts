import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type StageConfig = {
  environment: 'demo' | 'prod';
  domainPrefix: string;
  dbMultiAz: boolean;
  backupDays: number;
  deletionProtection: boolean;
  logRetentionDays: number;
  demoBanner: boolean;
  alertsFromEmail: string;
  googleClientId?: string;
  googleClientSecret?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  microsoftTenantId?: string;
  appleClientId?: string;
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
  callbackUrls: string[];
  logoutUrls: string[];
  whatsappSecretArn?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceAccountantOffice?: string;
  stripePricePmeCorporate?: string;
};

const REQUIRED_FIELDS = ['environment', 'domainPrefix', 'dbMultiAz', 'backupDays', 'deletionProtection', 'logRetentionDays', 'demoBanner', 'alertsFromEmail'] as const;

export function loadConfig(stage: string): StageConfig {
  if (stage !== 'demo' && stage !== 'prod') throw new Error(`Unknown stage '${stage}'. Use 'demo' or 'prod'.`);
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'config', `${stage}.json`), 'utf8')) as StageConfig;
  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined) throw new Error(`config/${stage}.json is missing required field '${field}'.`);
  }
  if (raw.environment !== stage) throw new Error(`config/${stage}.json declares environment '${raw.environment}', expected '${stage}'.`);
  return raw;
}
