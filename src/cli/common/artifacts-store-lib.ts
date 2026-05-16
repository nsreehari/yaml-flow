/**
 * artifacts-store-lib.ts
 *
 * Backend-neutral artifact store built on BlobStorage.
 * Supports text + binary content, CRUD, listing, and lightweight metadata.
 */

import type { BlobStat, BlobStorage } from './storage-interface.js';

export interface ArtifactInfo {
  key: string;
  size?: number;
  updatedAt?: string;
  contentType?: string;
}

export interface ArtifactsStore {
  exists(key: string): boolean;
  putText(key: string, content: string, contentType?: string): ArtifactInfo;
  putBytes(key: string, content: Uint8Array, contentType?: string): ArtifactInfo;
  getText(key: string): string | null;
  getBytes(key: string): Uint8Array | null;
  head(key: string): ArtifactInfo | null;
  list(prefix?: string): ArtifactInfo[];
  remove(key: string): void;
}

export interface ChatIndexRecord {
  serial: number;
  role: string;
  stored_name: string;
  path: string;
  updated_at?: string | null;
}

export interface ChatRecord extends ChatIndexRecord {
  text: string;
}

export interface ChatSignal {
  count: number;
  latest_mtime_ms: number;
  processing: boolean;
}

export interface ChatArtifactsStore {
  indexKey(cardPrefix: string): string;
  loadIndex(cardPrefix: string): ChatIndexRecord[];
  saveIndex(cardPrefix: string, records: ChatIndexRecord[]): void;
  nextSerial(cardPrefix: string): number;
  appendIndexRecord(cardPrefix: string, record: ChatIndexRecord): void;
  readRecords(cardPrefix: string): ChatRecord[];
  clear(cardPrefix: string): void;
  readSignal(cardPrefix: string): ChatSignal;
}

export interface FileArtifactsStore {
  nextSerial(cardPrefix: string, seedNames?: string[]): number;
  buildStoredName(displayName: string, serial: number, opts?: { maxLen?: number }): string;
  allocateStoredName(cardPrefix: string, displayName: string, opts?: { seedNames?: string[]; maxLen?: number }): string;
}

export interface CardFileMetadata {
  name: string;
  stored_name: string;
  size: number | null;
  mime_type: string | null;
  path: string | null;
  uploaded_at: string | null;
}

export type CardFileLookupResult =
  | { ok: true; file: CardFileMetadata }
  | { ok: false; reason: 'index_out_of_range' | 'missing_stored_name' | 'stale_reference' };

export interface CardFileMetadataStore {
  read(cardData: unknown): CardFileMetadata[];
  normalizeIncoming(payloadFiles: unknown, defaultUploadedAt?: string): CardFileMetadata[];
  merge(cardData: Record<string, unknown>, incoming: CardFileMetadata[]): CardFileMetadata[];
  resolve(cardData: unknown, index: number, expectedStoredName?: string | null): CardFileLookupResult;
}

function nowIso(): string {
  return new Date().toISOString();
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function statToInfo(stat: BlobStat | null): ArtifactInfo | null {
  if (!stat) return null;
  return {
    key: stat.key,
    size: stat.size,
    updatedAt: stat.updatedAt,
    contentType: stat.contentType,
  };
}

function parseLeadingSerial(fileName: string): number {
  const m = String(fileName || '').match(/^(\d+)[-_]/);
  return m ? parseInt(m[1], 10) : 0;
}

function normalizeDisplayFileName(name: string): string {
  const input = String(name || '').trim();
  if (!input) return 'upload.bin';
  const slash = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'));
  const base = slash >= 0 ? input.slice(slash + 1) : input;
  return base || 'upload.bin';
}

function normalizeStem(rawStem: string): string {
  const normalized = String(rawStem || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'file';
}

function normalizeExt(rawExt: string): string {
  if (!rawExt || rawExt === '.') return '';
  const extBody = String(rawExt).replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return extBody ? `.${extBody}` : '';
}

function splitBaseExt(name: string): { stem: string; ext: string } {
  const base = normalizeDisplayFileName(name);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return { stem: base, ext: '' };
  return { stem: base.slice(0, dot), ext: base.slice(dot) };
}

function basenameFromKey(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash >= 0 ? key.slice(slash + 1) : key;
}

export function createArtifactsStore(blob: BlobStorage): ArtifactsStore {
  function head(key: string): ArtifactInfo | null {
    const fromStat = blob.stat ? statToInfo(blob.stat(key)) : null;
    if (fromStat) return fromStat;

    if (!blob.exists(key)) return null;
    const content = blob.read(key);
    if (content === null) return { key };
    return {
      key,
      size: utf8ByteLength(content),
    };
  }

  return {
    exists(key: string): boolean {
      return blob.exists(key);
    },

    putText(key: string, content: string, contentType = 'text/plain; charset=utf-8'): ArtifactInfo {
      blob.write(key, content);
      const info = head(key) ?? { key };
      info.contentType = contentType;
      info.updatedAt = info.updatedAt ?? nowIso();
      info.size = info.size ?? utf8ByteLength(content);
      return info;
    },

    putBytes(key: string, content: Uint8Array, contentType = 'application/octet-stream'): ArtifactInfo {
      if (blob.writeBytes) {
        blob.writeBytes(key, content);
      } else {
        // Fallback for text-only backends.
        const envelope = JSON.stringify({ __kind: 'bytes-array', data: [...content] });
        blob.write(key, envelope);
      }
      const info = head(key) ?? { key };
      info.contentType = contentType;
      info.updatedAt = info.updatedAt ?? nowIso();
      info.size = info.size ?? content.byteLength;
      return info;
    },

    getText(key: string): string | null {
      const raw = blob.read(key);
      if (raw === null) {
        if (!blob.readBytes) return null;
        const bytes = blob.readBytes(key);
        if (bytes === null) return null;
        return Buffer.from(bytes).toString('utf-8');
      }
      try {
        const parsed = JSON.parse(raw) as { __kind?: string; data?: number[] };
        if (parsed && parsed.__kind === 'bytes-array' && Array.isArray(parsed.data)) {
          return new TextDecoder('utf-8').decode(new Uint8Array(parsed.data));
        }
      } catch {
        // plain text path
      }
      return raw;
    },

    getBytes(key: string): Uint8Array | null {
      if (blob.readBytes) {
        const bytes = blob.readBytes(key);
        if (bytes !== null) return bytes;
      }
      const raw = blob.read(key);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as { __kind?: string; data?: number[] };
        if (parsed && parsed.__kind === 'bytes-array' && Array.isArray(parsed.data)) {
          return new Uint8Array(parsed.data);
        }
      } catch {
        // plain text path
      }
      return new TextEncoder().encode(raw);
    },

    head,

    list(prefix = ''): ArtifactInfo[] {
      return blob.listKeys(prefix)
        .map((key) => head(key) ?? { key })
        .sort((a, b) => a.key.localeCompare(b.key));
    },

    remove(key: string): void {
      blob.remove(key);
    },
  };
}

export function createChatArtifactsStore(
  store: ArtifactsStore,
  opts?: { indexFileName?: string },
): ChatArtifactsStore {
  const indexFileName = opts?.indexFileName || '.index.json';

  function indexKey(cardPrefix: string): string {
    return `${cardPrefix}/${indexFileName}`;
  }

  function loadIndex(cardPrefix: string): ChatIndexRecord[] {
    const raw = store.getText(indexKey(cardPrefix));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((row) => row && typeof row.stored_name === 'string')
        .map((row) => ({
          serial: Number(row.serial || parseLeadingSerial(String(row.stored_name)) || 0),
          role: String(row.role || 'system').toLowerCase(),
          stored_name: String(row.stored_name),
          path: typeof row.path === 'string' ? row.path : `${cardPrefix}/chats/${String(row.stored_name)}`,
          updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
        }));
    } catch {
      return [];
    }
  }

  function saveIndex(cardPrefix: string, records: ChatIndexRecord[]): void {
    store.putText(indexKey(cardPrefix), JSON.stringify(records, null, 2), 'application/json; charset=utf-8');
  }

  function nextSerial(cardPrefix: string): number {
    const index = loadIndex(cardPrefix);
    let maxSeen = 0;
    for (const row of index) {
      const serial = Number(row.serial || 0);
      if (Number.isFinite(serial) && serial > maxSeen) maxSeen = serial;
    }
    return maxSeen + 1;
  }

  function appendIndexRecord(cardPrefix: string, record: ChatIndexRecord): void {
    const index = loadIndex(cardPrefix);
    index.push(record);
    saveIndex(cardPrefix, index);
  }

  function readRecords(cardPrefix: string): ChatRecord[] {
    const index = loadIndex(cardPrefix);
    const out: ChatRecord[] = [];
    for (const row of index) {
      const key = `${cardPrefix}/${row.stored_name}`;
      const text = store.getText(key);
      if (text === null) continue;
      out.push({
        serial: Number(row.serial || parseLeadingSerial(row.stored_name) || 0),
        role: String(row.role || 'system').toLowerCase(),
        text,
        path: typeof row.path === 'string' ? row.path : `${cardPrefix}/chats/${row.stored_name}`,
        stored_name: row.stored_name,
        updated_at: row.updated_at || null,
      });
    }
    out.sort((a, b) => a.serial - b.serial || a.stored_name.localeCompare(b.stored_name));
    return out;
  }

  function clear(cardPrefix: string): void {
    const prefix = `${cardPrefix}/`;
    for (const entry of store.list(prefix)) store.remove(entry.key);
  }

  function readSignal(cardPrefix: string): ChatSignal {
    const prefix = `${cardPrefix}/`;
    const entries = store.list(prefix);
    let count = 0;
    let latestMtimeMs = 0;
    let processing = false;
    for (const entry of entries) {
      const name = entry.key.slice(prefix.length);
      if (name === '.processing') {
        processing = true;
        continue;
      }
      if (!/^(\d+)[-_]([a-z0-9_-]+)\.txt$/i.test(name)) continue;
      count += 1;
      const mtimeMs = entry.updatedAt ? Number(new Date(entry.updatedAt).getTime() || 0) : 0;
      if (mtimeMs > latestMtimeMs) latestMtimeMs = mtimeMs;
    }
    return { count, latest_mtime_ms: latestMtimeMs, processing };
  }

  return {
    indexKey,
    loadIndex,
    saveIndex,
    nextSerial,
    appendIndexRecord,
    readRecords,
    clear,
    readSignal,
  };
}

export function createFileArtifactsStore(store: ArtifactsStore): FileArtifactsStore {
  function nextSerial(cardPrefix: string, seedNames?: string[]): number {
    let maxSeen = 0;
    const names: string[] = [];
    if (Array.isArray(seedNames)) names.push(...seedNames);
    for (const entry of store.list(`${cardPrefix}/`)) {
      names.push(basenameFromKey(entry.key));
    }
    for (const name of names) {
      const serial = parseLeadingSerial(name);
      if (Number.isFinite(serial) && serial > maxSeen) maxSeen = serial;
    }
    return maxSeen + 1;
  }

  function buildStoredName(displayName: string, serial: number, opts?: { maxLen?: number }): string {
    const maxLen = Number(opts?.maxLen || 32);
    const { stem, ext } = splitBaseExt(displayName);
    const safeExt = normalizeExt(ext);
    const safeStem = normalizeStem(stem);
    const prefix = `${String(serial).padStart(3, '0')}-`;

    let keepExt = safeExt;
    let stemBudget = maxLen - prefix.length - keepExt.length;
    if (stemBudget < 1) {
      keepExt = '';
      stemBudget = maxLen - prefix.length;
    }

    const outStem = safeStem.slice(0, Math.max(1, stemBudget));
    let out = `${prefix}${outStem}${keepExt}`;
    if (out.length > maxLen) out = out.slice(0, maxLen).replace(/\.$/, '');
    return out;
  }

  function allocateStoredName(cardPrefix: string, displayName: string, opts?: { seedNames?: string[]; maxLen?: number }): string {
    let serial = nextSerial(cardPrefix, opts?.seedNames);
    let out = buildStoredName(displayName, serial, { maxLen: opts?.maxLen });
    while (store.exists(`${cardPrefix}/${out}`)) {
      serial += 1;
      out = buildStoredName(displayName, serial, { maxLen: opts?.maxLen });
    }
    return out;
  }

  return {
    nextSerial,
    buildStoredName,
    allocateStoredName,
  };
}

export function createCardFileMetadataStore(): CardFileMetadataStore {
  function normalizeIncoming(payloadFiles: unknown, defaultUploadedAt?: string): CardFileMetadata[] {
    if (!Array.isArray(payloadFiles)) return [];
    const out: CardFileMetadata[] = [];
    for (const raw of payloadFiles) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.stored_name !== 'string') continue;
      out.push({
        name: typeof row.name === 'string' ? row.name : row.stored_name,
        stored_name: row.stored_name,
        size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : null,
        mime_type: typeof row.mime_type === 'string' ? row.mime_type : null,
        path: typeof row.path === 'string' ? row.path : null,
        uploaded_at: typeof row.uploaded_at === 'string' ? row.uploaded_at : (defaultUploadedAt || null),
      });
    }
    return out;
  }

  function read(cardData: unknown): CardFileMetadata[] {
    if (!cardData || typeof cardData !== 'object') return [];
    const row = cardData as Record<string, unknown>;
    return normalizeIncoming(row.files, undefined);
  }

  function merge(cardData: Record<string, unknown>, incoming: CardFileMetadata[]): CardFileMetadata[] {
    const existing = read(cardData);
    if (incoming.length === 0) {
      cardData.files = existing;
      return existing;
    }
    const known = new Set(existing.map((f) => f.stored_name));
    for (const file of incoming) {
      if (known.has(file.stored_name)) continue;
      existing.push(file);
      known.add(file.stored_name);
    }
    cardData.files = existing;
    return existing;
  }

  function resolve(cardData: unknown, index: number, expectedStoredName?: string | null): CardFileLookupResult {
    const files = read(cardData);
    if (!Number.isInteger(index) || index < 0 || index >= files.length) {
      return { ok: false, reason: 'index_out_of_range' };
    }
    const file = files[index];
    if (!file || !file.stored_name) return { ok: false, reason: 'missing_stored_name' };
    if (expectedStoredName && expectedStoredName !== file.stored_name) {
      return { ok: false, reason: 'stale_reference' };
    }
    return { ok: true, file };
  }

  return {
    read,
    normalizeIncoming,
    merge,
    resolve,
  };
}
