import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EventBridgeHandler } from 'aws-lambda';
import { db } from '../lib/db';
import { fetchSource, type RegulatorySourceConfig } from '../regulatory/connectors';

export type RegulatoryRunResult = { sources: number; documents: number; updates: number; failures: number };

/** Reads the `REGULATORY_SOURCES` env var (JSON array) set by the CDK stack. */
export function parseSourceConfig(raw: string | undefined): RegulatorySourceConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('REGULATORY_SOURCES is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('REGULATORY_SOURCES must be an array');
  return parsed
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({
      key: String(s.key ?? '').trim(),
      name: String(s.name ?? s.key ?? '').trim(),
      url: String(s.url ?? '').trim(),
      kind: String(s.kind ?? '').trim(),
      jurisdiction: s.jurisdiction === undefined ? undefined : String(s.jurisdiction),
    }))
    .filter((s) => s.key !== '' && s.url !== '' && s.kind !== '');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Hourly ingest (EventBridge cron). Upserts configured sources, pulls new
 * documents, stores a raw artifact in S3 for provenance and records a
 * `RegulatoryUpdate` (status NEW) for every first-seen document. Never mutates
 * tax rules: promotion to a DRAFT candidate is a human action via the API.
 */
export const handler: EventBridgeHandler<'Scheduled Event', unknown, RegulatoryRunResult> = async () => {
  const bucket = process.env.DOCUMENT_BUCKET;
  const s3 = bucket ? new S3Client({}) : undefined;

  const configured = parseSourceConfig(process.env.REGULATORY_SOURCES);
  for (const source of configured) {
    await db.regulatorySource.upsert({
      where: { key: source.key },
      update: { name: source.name, url: source.url, kind: source.kind, jurisdiction: source.jurisdiction ?? 'MZ' },
      create: { key: source.key, name: source.name, url: source.url, kind: source.kind, jurisdiction: source.jurisdiction ?? 'MZ' },
    });
  }

  const sources = await db.regulatorySource.findMany({ where: { enabled: true }, orderBy: { key: 'asc' } });

  let documents = 0;
  let updates = 0;
  let failures = 0;

  for (const source of sources) {
    try {
      const { items, raw } = await fetchSource({ key: source.key, name: source.name, url: source.url, kind: source.kind });
      let rawKey: string | undefined;
      if (s3 && bucket) {
        rawKey = `regulatory/${source.key}/${hash(raw).slice(0, 32)}.json`;
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: rawKey, Body: raw, ContentType: 'application/json' }));
      }

      for (const item of items) {
        const contentHash = hash(JSON.stringify(item));
        const existing = await db.sourceDocument.findUnique({ where: { sourceId_externalId: { sourceId: source.id, externalId: item.externalId } } });
        if (existing) {
          if (existing.contentHash !== contentHash) {
            await db.sourceDocument.update({
              where: { id: existing.id },
              data: { title: item.title, summary: item.summary ?? null, url: item.url, publishedAt: item.publishedAt ?? null, contentHash, rawKey: rawKey ?? existing.rawKey },
            });
          }
          continue;
        }
        const created = await db.sourceDocument.create({
          data: {
            sourceId: source.id,
            externalId: item.externalId,
            title: item.title,
            summary: item.summary ?? null,
            url: item.url,
            publishedAt: item.publishedAt ?? null,
            contentHash,
            rawKey: rawKey ?? null,
          },
        });
        await db.regulatoryUpdate.create({
          data: {
            documentId: created.id,
            title: item.title,
            summary: item.summary ?? null,
            url: item.url,
            sourceKey: source.key,
            category: 'NEWS',
            status: 'NEW',
            affectedRuleCodes: [],
            publishedAt: item.publishedAt ?? null,
          },
        });
        documents += 1;
        updates += 1;
      }

      await db.regulatorySource.update({ where: { id: source.id }, data: { lastFetchedAt: new Date(), lastStatus: 'OK', lastError: null } });
    } catch (err) {
      failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      await db.regulatorySource.update({ where: { id: source.id }, data: { lastFetchedAt: new Date(), lastStatus: 'ERROR', lastError: message.slice(0, 1000) } });
      console.error(JSON.stringify({ level: 'error', worker: 'regulatory', source: source.key, message }));
    }
  }

  const result: RegulatoryRunResult = { sources: sources.length, documents, updates, failures };
  console.log(JSON.stringify({ level: 'info', worker: 'regulatory', ...result }));
  return result;
};
