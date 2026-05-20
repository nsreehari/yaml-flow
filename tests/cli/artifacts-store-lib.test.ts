import { describe, expect, it } from 'vitest';

import {
  createArtifactsStore,
  createCardFileMetadataStore,
  createFileArtifactsStore,
} from '../../src/cli/common/artifacts-store-lib.js';
import type { BlobStat, BlobStorage } from '../../src/cli/common/storage-interface.js';

class MemoryBlobStorage implements BlobStorage {
  private text = new Map<string, string>();
  private bytes = new Map<string, Uint8Array>();
  private meta = new Map<string, BlobStat>();
  private tick = 0;

  private touch(key: string, size: number, contentType?: string): void {
    this.tick += 1;
    this.meta.set(key, {
      key,
      size,
      updatedAt: new Date(1700000000000 + this.tick).toISOString(),
      contentType,
    });
  }

  read(key: string): string | null {
    return this.text.has(key) ? this.text.get(key) ?? null : null;
  }

  write(key: string, content: string): void {
    this.text.set(key, content);
    this.bytes.delete(key);
    this.touch(key, new TextEncoder().encode(content).byteLength, 'text/plain; charset=utf-8');
  }

  exists(key: string): boolean {
    return this.text.has(key) || this.bytes.has(key);
  }

  remove(key: string): void {
    this.text.delete(key);
    this.bytes.delete(key);
    this.meta.delete(key);
  }

  readBytes(key: string): Uint8Array | null {
    return this.bytes.has(key) ? this.bytes.get(key) ?? null : null;
  }

  writeBytes(key: string, content: Uint8Array): void {
    this.bytes.set(key, new Uint8Array(content));
    this.text.delete(key);
    this.touch(key, content.byteLength, 'application/octet-stream');
  }

  listKeys(prefix = ''): string[] {
    const keys = new Set<string>([...this.text.keys(), ...this.bytes.keys()]);
    return [...keys].filter((k) => !prefix || k.startsWith(prefix)).sort();
  }

  stat(key: string): BlobStat | null {
    return this.meta.get(key) ?? null;
  }
}

describe('artifacts-store-lib helpers', () => {
  it('normalizes and merges card file metadata by stored_name', () => {
    const meta = createCardFileMetadataStore();
    const now = '2026-05-05T00:00:00.000Z';

    const incoming = meta.normalizeIncoming([
      { stored_name: '001-a.txt', name: 'A.txt', size: 12, mime_type: 'text/plain' },
      { stored_name: '001-a.txt', name: 'duplicate should be ignored' },
      { stored_name: '002-b.txt' },
      { bad: 'row' },
    ], now);

    expect(incoming).toHaveLength(3);
    expect(incoming[0].chat).toBe(false);
    expect(incoming[1].uploaded_at).toBe(now);
    expect(incoming[2].name).toBe('002-b.txt');
    expect(incoming[2].chat).toBe(false);

    const withChat = meta.normalizeIncoming([
      { stored_name: '003-c.txt', name: 'C.txt', chat: true },
    ], now);
    expect(withChat[0].chat).toBe(true);

    const cardData: Record<string, unknown> = {
      files: [{ stored_name: '001-a.txt', name: 'existing' }],
    };

    const merged = meta.merge(cardData, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0].stored_name).toBe('001-a.txt');
    expect(merged[0].chat).toBe(false);
    expect(merged[1].stored_name).toBe('002-b.txt');
    expect(merged[1].chat).toBe(false);
  });

  it('resolves card file lookups with stale and bounds checks', () => {
    const meta = createCardFileMetadataStore();
    const cardData = {
      files: [
        { stored_name: '001-a.txt', name: 'A.txt' },
        { stored_name: '002-b.txt', name: 'B.txt' },
      ],
    };

    const ok = meta.resolve(cardData, 1, '002-b.txt');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.file.name).toBe('B.txt');

    const stale = meta.resolve(cardData, 1, '999-x.txt');
    expect(stale).toEqual({ ok: false, reason: 'stale_reference' });

    const outOfRange = meta.resolve(cardData, 3, null);
    expect(outOfRange).toEqual({ ok: false, reason: 'index_out_of_range' });
  });

  it('allocates file stored names using seed names and existing artifacts', () => {
    const blob = new MemoryBlobStorage();
    const artifacts = createArtifactsStore(blob);
    const files = createFileArtifactsStore(artifacts);

    artifacts.putText('card-1/003_existing.txt', 'x');

    const next = files.allocateStoredName('card-1', 'Quarterly Report.md', {
      seedNames: ['001_seed.txt', '002_seed.txt'],
      maxLen: 20,
    });

    expect(next).toBe('004-quarterly_rep.md');

    artifacts.putText(`card-1/${next}`, 'y');
    const next2 = files.allocateStoredName('card-1', 'Quarterly Report.md', {
      seedNames: ['001_seed.txt', '002_seed.txt'],
      maxLen: 20,
    });
    expect(next2).toBe('005-quarterly_rep.md');
  });
});
