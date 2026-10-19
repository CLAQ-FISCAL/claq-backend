import { describe, expect, it } from 'vitest';
import { fetchSource, parseAtDocuments, parseDateFromId, toAbsoluteUrl } from '../src/regulatory/connectors';

const BASE = 'https://www.at.gov.mz';

const SAMPLE = JSON.stringify([
  {
    id: '01-09-2026-pr-destaca-papel-da-at',
    rawId: '01-09-2026 - PR DESTACA PAPEL DA AT',
    label: '01 09 2026   PR DESTACA PAPEL DA AT',
    desc: 'Documentação oficial disponível para consulta.',
    documents: [
      { id: 'a', title: 'Nota', size: '126 KB', date: '08/09/2026', url: '/api/webdav?path=%2FNOTICIAS%2Fx%2FNota.pdf' },
      { id: 'b', title: 'Foto', url: '/api/webdav?path=%2FNOTICIAS%2Fx%2FFoto.jpg' },
    ],
  },
  { id: 'sem-documentos', rawId: 'Sem Documentos', documents: [] },
  { rawId: 'sem-id' },
]);

describe('toAbsoluteUrl', () => {
  it('resolves relative urls against the origin', () => {
    expect(toAbsoluteUrl('/api/webdav?path=x', BASE)).toBe('https://www.at.gov.mz/api/webdav?path=x');
  });

  it('keeps absolute urls untouched', () => {
    expect(toAbsoluteUrl('https://example.com/a', BASE)).toBe('https://example.com/a');
  });

  it('falls back to the base for empty values', () => {
    expect(toAbsoluteUrl('', BASE)).toBe(BASE);
  });
});

describe('parseDateFromId', () => {
  it('parses the DD-MM-YYYY prefix', () => {
    const date = parseDateFromId('01-09-2026-pr-destaca');
    expect(date?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('returns undefined without a date prefix', () => {
    expect(parseDateFromId('noticias')).toBeUndefined();
  });

  it('rejects impossible months', () => {
    expect(parseDateFromId('01-13-2026-x')).toBeUndefined();
  });
});

describe('parseAtDocuments', () => {
  it('normalizes at.gov.mz news entries', () => {
    const items = parseAtDocuments(SAMPLE, BASE);
    expect(items).toHaveLength(2);

    const first = items[0];
    expect(first.externalId).toBe('01-09-2026-pr-destaca-papel-da-at');
    expect(first.title).toBe('01 09 2026 PR DESTACA PAPEL DA AT');
    expect(first.summary).toBe('Documentação oficial disponível para consulta.');
    expect(first.url).toBe('https://www.at.gov.mz/api/webdav?path=%2FNOTICIAS%2Fx%2FNota.pdf');
    expect(first.attachments).toHaveLength(2);
    expect(first.publishedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');

    const second = items[1];
    expect(second.externalId).toBe('sem-documentos');
    expect(second.url).toBe(BASE);
    expect(second.attachments).toEqual([]);
  });

  it('returns an empty list for malformed payloads', () => {
    expect(parseAtDocuments('not json', BASE)).toEqual([]);
    expect(parseAtDocuments('{"not":"array"}', BASE)).toEqual([]);
  });
});

describe('fetchSource', () => {
  it('throws for an unknown connector kind', async () => {
    await expect(fetchSource({ key: 'k', name: 'n', url: BASE, kind: 'NOPE' })).rejects.toThrow(/Unknown regulatory connector/);
  });

  it('uses the AT connector against injected fetch', async () => {
    const fetchImpl = (async () => new Response(SAMPLE, { status: 200 })) as unknown as typeof globalThis.fetch;
    const result = await fetchSource({ key: 'at-news', name: 'AT', url: `${BASE}/api/documents?root=NOTICIAS`, kind: 'AT_DOCUMENTS' }, fetchImpl);
    expect(result.items).toHaveLength(2);
    expect(result.raw).toBe(SAMPLE);
  });

  it('surfaces non-2xx responses', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch;
    await expect(fetchSource({ key: 'at-news', name: 'AT', url: `${BASE}/x`, kind: 'AT_DOCUMENTS' }, fetchImpl)).rejects.toThrow(/HTTP 503/);
  });
});
