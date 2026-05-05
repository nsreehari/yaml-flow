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

const INDEX_KEY = '.artifacts-index.json';

interface ArtifactIndexEntry {
  key: string;
  size?: number;
  updatedAt?: string;
  contentType?: string;
}

interface ArtifactIndex {
  entries: Record<string, ArtifactIndexEntry>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function loadIndex(blob: BlobStorage): ArtifactIndex {
  const raw = blob.read(INDEX_KEY);
  if (!raw) return { entries: {} };
  try {
    const parsed = JSON.parse(raw) as ArtifactIndex;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch {
    // fall through
  }
  return { entries: {} };
}

function saveIndex(blob: BlobStorage, index: ArtifactIndex): void {
  blob.write(INDEX_KEY, JSON.stringify(index, null, 2));
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

function updateIndex(index: ArtifactIndex, key: string, info: ArtifactInfo): void {
  index.entries[key] = {
    key,
    size: info.size,
    updatedAt: info.updatedAt,
    contentType: info.contentType,
  };
}

export function createArtifactsStore(blob: BlobStorage): ArtifactsStore {
  function head(key: string): ArtifactInfo | null {
    const fromStat = blob.stat ? statToInfo(blob.stat(key)) : null;
    if (fromStat) return fromStat;

    const index = loadIndex(blob);
    const entry = index.entries[key];
    if (entry) return { ...entry };

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
      const index = loadIndex(blob);
      updateIndex(index, key, info);
      saveIndex(blob, index);
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
      const index = loadIndex(blob);
      updateIndex(index, key, info);
      saveIndex(blob, index);
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
      const infoByKey = new Map<string, ArtifactInfo>();

      if (blob.listKeys) {
        for (const key of blob.listKeys(prefix)) {
          if (key === INDEX_KEY) continue;
          const info = head(key) ?? { key };
          infoByKey.set(key, info);
        }
      }

      const index = loadIndex(blob);
      for (const [key, entry] of Object.entries(index.entries)) {
        if (key === INDEX_KEY || (prefix && !key.startsWith(prefix))) continue;
        if (!infoByKey.has(key)) infoByKey.set(key, { ...entry });
      }

      return [...infoByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    },

    remove(key: string): void {
      blob.remove(key);
      const index = loadIndex(blob);
      delete index.entries[key];
      saveIndex(blob, index);
    },
  };
}
