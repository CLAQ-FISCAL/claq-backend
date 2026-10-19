/**
 * Regulatory source connectors. Each connector turns a remote page/API into a
 * normalized list of `FetchedItem`s. Parsing is kept pure (no network) so it can
 * be unit-tested against captured fixtures.
 */

export type RegulatorySourceConfig = {
  key: string;
  name: string;
  url: string;
  kind: string;
  jurisdiction?: string;
};

export type Attachment = { title: string; url: string; date?: string; size?: string };

export type FetchedItem = {
  externalId: string;
  title: string;
  summary?: string;
  url: string;
  publishedAt?: Date;
  attachments: Attachment[];
};

export type FetchResult = { items: FetchedItem[]; raw: string };

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = 'CLAQ-RegulatoryBot/1.0 (+https://claq.co.mz)';

/** Resolves a possibly-relative URL against an absolute base; falls back to the base. */
export function toAbsoluteUrl(url: string, base: string): string {
  if (!url) return base;
  try {
    return new URL(url, base).toString();
  } catch {
    return base;
  }
}

/** AT news folders are named `DD-MM-YYYY - <title>`; recover the date from the id. */
export function parseDateFromId(id: string): Date | undefined {
  const match = /^(\d{2})-(\d{2})-(\d{4})/.exec(id.trim());
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return new Date(Date.UTC(year, month - 1, day));
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Parses the JSON from `https://www.at.gov.mz/api/documents?root=NOTICIAS`.
 * Shape: `[{ id, rawId, label, desc, documents: [{ title, url, date, size }] }]`.
 */
export function parseAtDocuments(payload: string, baseUrl: string): FetchedItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items: FetchedItem[] = [];
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const externalId = str(entry.id);
    const title = str(entry.label) ?? str(entry.rawId) ?? externalId;
    if (!externalId || !title) continue;

    const attachments: Attachment[] = [];
    if (Array.isArray(entry.documents)) {
      for (const doc of entry.documents) {
        if (typeof doc !== 'object' || doc === null) continue;
        const d = doc as Record<string, unknown>;
        const docUrl = str(d.downloadUrl) ?? str(d.url) ?? str(d.viewUrl);
        if (!docUrl) continue;
        attachments.push({ title: str(d.title) ?? externalId, url: toAbsoluteUrl(docUrl, baseUrl), date: str(d.date), size: str(d.size) });
      }
    }

    items.push({
      externalId,
      title: title.replace(/\s+/g, ' ').trim(),
      summary: str(entry.desc),
      url: attachments[0]?.url ?? baseUrl,
      publishedAt: parseDateFromId(externalId),
      attachments,
    });
  }
  return items;
}

type Connector = (source: RegulatorySourceConfig, fetchImpl: typeof globalThis.fetch) => Promise<FetchResult>;

const CONNECTORS: Record<string, Connector> = {
  AT_DOCUMENTS: async (source, fetchImpl) => {
    const response = await fetchImpl(source.url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${source.url}`);
    const raw = await response.text();
    return { items: parseAtDocuments(raw, new URL(source.url).origin), raw };
  },
};

/** Fetches and normalizes a source. `fetchImpl` is injectable for tests. */
export async function fetchSource(source: RegulatorySourceConfig, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<FetchResult> {
  const connector = CONNECTORS[source.kind];
  if (!connector) throw new Error(`Unknown regulatory connector kind '${source.kind}'.`);
  return connector(source, fetchImpl);
}
