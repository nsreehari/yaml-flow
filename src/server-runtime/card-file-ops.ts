/**
 * server-runtime/card-file-ops.ts
 *
 * Per-card file upload / metadata-merge orchestration extracted from
 * createSingleBoardServerRuntime. The factory takes narrow callbacks for
 * the small handful of closure-owned helpers (card-store reads,
 * card-data writes, chat-record writes, artifact stores, file-metadata
 * normaliser) and exposes the upload entry point plus its read helper.
 */

import type { CardFileMetadataStore } from '../cli/common/artifacts-store-lib.js';

const MAX_STORED_FILE_NAME_LEN = 32;

/** Subset of the per-card files artifact store consumed by file-ops. */
interface FilesArtifactsStoreLike {
  putBytes(key: string, content: Uint8Array, contentType?: string): unknown | Promise<unknown>;
}

export interface CardFileOpsDeps {
  /** Sanitised card-id suitable for use as a storage prefix. */
  safeCardId: (cardId: string) => string;
  /** Returns the per-card artifact stores; `files` is the bytes sink. */
  artifactsStores: (cardId: string) => { files: FilesArtifactsStoreLike | null };
  /** Card-file-metadata store wired against the runtime's persistence layer. */
  cardFileMetadataStore: () => CardFileMetadataStore;
  /** Read the persisted card from the store (used to count existing files). */
  readCardFromStore: (cardId: string) => Promise<Record<string, unknown> | null>;
  /** Apply a local-only update to a card; same shape as updateCardLocalOnly. */
  updateCardLocalOnly: (cardId: string, updateFn: (card: Record<string, unknown>) => Record<string, unknown> | void) => Promise<void>;
  /** Append a chat record (used for in-chat upload announcements). */
  writeChatRecord: (cardId: string, role: string, text: string, files: unknown[], turnId: string) => unknown;
}

export interface CardFileOps {
  uploadCardFile: (
    cardId: string,
    requestedName: string,
    contentType: string,
    buffer: Uint8Array,
    opts?: { inChat?: boolean; turnId?: string },
  ) => Promise<{ ok: true; file: Record<string, unknown> }>;
  readCardStoredFileNames: (cardId: string) => Promise<string[]>;
}

/** Pure helper: extract a basename from a possibly-pathy display name. */
export function normalizeDisplayFileName(name: string): string {
  const input = String(name || '').trim();
  if (!input) return 'upload.bin';
  const lastSlash = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'));
  const base = lastSlash >= 0 ? input.slice(lastSlash + 1) : input;
  return base || 'upload.bin';
}

export function createCardFileOps(deps: CardFileOpsDeps): CardFileOps {
  const {
    safeCardId,
    artifactsStores,
    cardFileMetadataStore,
    readCardFromStore,
    updateCardLocalOnly,
    writeChatRecord,
  } = deps;

  async function readCardStoredFileNames(cardId: string): Promise<string[]> {
    const names: string[] = [];
    try {
      const card = await readCardFromStore(cardId);
      if (!card) return names;
      const metadata = cardFileMetadataStore().read(card.card_data && typeof card.card_data === 'object' ? card.card_data : null);
      for (const entry of metadata) names.push(String((entry as { stored_name?: unknown }).stored_name ?? ''));
    } catch { /* ignore */ }
    return names;
  }

  async function persistUploadedFile(
    cardId: string,
    requestedName: string,
    contentType: string,
    buffer: Uint8Array,
  ): Promise<Record<string, unknown>> {
    const sid = safeCardId(cardId);
    const stores = artifactsStores(cardId);
    const displayName = normalizeDisplayFileName(requestedName);
    const existingNames = await readCardStoredFileNames(cardId);
    const serial = String(existingNames.length + 1).padStart(3, '0');
    const storedName = `${serial}-${displayName}`.slice(-(MAX_STORED_FILE_NAME_LEN + 4));

    if (stores.files) {
      await stores.files.putBytes(`${sid}/${storedName}`, new Uint8Array(buffer), contentType || 'application/octet-stream');
    }

    return {
      name: displayName,
      stored_name: storedName,
      size: buffer.length,
      mime_type: contentType || 'application/octet-stream',
      uploaded_at: new Date().toISOString(),
    };
  }

  async function uploadCardFile(
    cardId: string,
    requestedName: string,
    contentType: string,
    buffer: Uint8Array,
    opts?: { inChat?: boolean; turnId?: string },
  ): Promise<{ ok: true; file: Record<string, unknown> }> {
    if (!buffer.length) {
      throw Object.assign(new Error('Empty upload body'), { statusCode: 400 });
    }

    const inChat = opts?.inChat === true;
    const file = await persistUploadedFile(cardId, requestedName, contentType, buffer);
    let uploadedFileIndex: number | null = null;

    await updateCardLocalOnly(cardId, (card) => {
      const now = new Date().toISOString();
      const cardData = card.card_data && typeof card.card_data === 'object' ? card.card_data as Record<string, unknown> : {};
      card.card_data = cardData;
      const incoming = cardFileMetadataStore().normalizeIncoming([{
        name: file.name,
        stored_name: file.stored_name,
        size: file.size,
        mime_type: file.mime_type,
        uploaded_at: file.uploaded_at || now,
        chat: inChat,
      }], now);
      const merged = cardFileMetadataStore().merge(cardData, incoming);
      uploadedFileIndex = merged.findIndex((entry) => entry.stored_name === file.stored_name);
      return card;
    });

    if (inChat) {
      const idxSuffix = typeof uploadedFileIndex === 'number' && uploadedFileIndex >= 0 ? ` #${uploadedFileIndex}` : '';
      writeChatRecord(cardId, 'system', `file uploaded: ${file.name} as ${file.stored_name}${idxSuffix}`, [], opts?.turnId ?? '');
    }

    return {
      ok: true,
      file: {
        ...file,
        ...(typeof uploadedFileIndex === 'number' && uploadedFileIndex >= 0 ? { file_idx: uploadedFileIndex } : {}),
        chat: inChat,
      },
      ...(typeof uploadedFileIndex === 'number' && uploadedFileIndex >= 0 ? { file_idx: uploadedFileIndex } : {}),
    };
  }

  return { uploadCardFile, readCardStoredFileNames };
}
