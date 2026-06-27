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
  writeChatRecord: (cardId: string, role: string, text: string, files: unknown[], turnId: string) => unknown | Promise<unknown>;
}

export interface UploadCardFilesMultipleInput {
  requestedName: string;
  contentType: string;
  buffer: Uint8Array;
}

export interface CardFileOps {
  uploadCardFile: (
    cardId: string,
    requestedName: string,
    contentType: string,
    buffer: Uint8Array,
    opts?: { inChat?: boolean; turnId?: string; suppressChatRecordWrite?: boolean },
  ) => Promise<{ ok: true; file: Record<string, unknown> }>;
  uploadCardFilesMultiple: (
    cardId: string,
    files: UploadCardFilesMultipleInput[],
    opts?: { message?: string },
  ) => Promise<{
    ok: true;
    files: Record<string, unknown>[];
    file_idxs: number[];
    filegroup: Record<string, unknown>;
  }>;
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
    seedCount?: number,
  ): Promise<Record<string, unknown>> {
    const sid = safeCardId(cardId);
    const stores = artifactsStores(cardId);
    const displayName = normalizeDisplayFileName(requestedName);
    const existingCount = typeof seedCount === 'number'
      ? seedCount
      : (await readCardStoredFileNames(cardId)).length;
    const serial = String(existingCount + 1).padStart(3, '0');
    const storedName = `${serial}-${displayName}`.slice(-(MAX_STORED_FILE_NAME_LEN + 4));

    if (!stores.files) {
      throw Object.assign(new Error(`artifactsStoreRef is not configured for card uploads: ${cardId}`), { statusCode: 500 });
    }

    await stores.files.putBytes(`${sid}/${storedName}`, new Uint8Array(buffer), contentType || 'application/octet-stream');

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
    opts?: { inChat?: boolean; turnId?: string; suppressChatRecordWrite?: boolean },
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

    if (inChat && opts?.suppressChatRecordWrite !== true) {
      const idxSuffix = typeof uploadedFileIndex === 'number' && uploadedFileIndex >= 0 ? ` #${uploadedFileIndex}` : '';
      await writeChatRecord(cardId, 'system', `file uploaded: ${file.name} as ${file.stored_name}${idxSuffix}`, [], opts?.turnId ?? '');
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

  async function uploadCardFilesMultiple(
    cardId: string,
    files: UploadCardFilesMultipleInput[],
    opts?: { message?: string },
  ): Promise<{ ok: true; files: Record<string, unknown>[]; file_idxs: number[]; filegroup: Record<string, unknown> }> {
    if (!Array.isArray(files) || files.length === 0) {
      throw Object.assign(new Error('uploadCardFilesMultiple requires at least one file'), { statusCode: 400 });
    }
    for (const entry of files) {
      if (!entry.buffer.length) {
        throw Object.assign(new Error('Empty upload body'), { statusCode: 400 });
      }
    }

    // Persist sequentially, seeding the serial from the current stored-file
    // count once and bumping per file. The metadata merge that makes these
    // files visible to readCardStoredFileNames only happens below, so without
    // an explicit seed every file in the batch would collide on the same
    // serial / index.
    const seedNames = await readCardStoredFileNames(cardId);
    let seed = seedNames.length;
    const persisted: Record<string, unknown>[] = [];
    for (const entry of files) {
      const file = await persistUploadedFile(cardId, entry.requestedName, entry.contentType, entry.buffer, seed);
      persisted.push(file);
      seed += 1;
    }

    const message = typeof opts?.message === 'string' ? opts.message : '';
    const fileIdxs: number[] = [];
    let filegroup: Record<string, unknown> = {};

    // Merge all file metadata and append the filegroup in a single update so
    // the batch lands atomically (no separate lost-update patch).
    await updateCardLocalOnly(cardId, (card) => {
      const now = new Date().toISOString();
      const cardData = card.card_data && typeof card.card_data === 'object' ? card.card_data as Record<string, unknown> : {};
      card.card_data = cardData;

      const incoming = cardFileMetadataStore().normalizeIncoming(persisted.map((file) => ({
        name: file.name,
        stored_name: file.stored_name,
        size: file.size,
        mime_type: file.mime_type,
        uploaded_at: file.uploaded_at || now,
        chat: false,
      })), now);
      const merged = cardFileMetadataStore().merge(cardData, incoming);

      fileIdxs.length = 0;
      for (const file of persisted) {
        fileIdxs.push(merged.findIndex((metaEntry) => metaEntry.stored_name === file.stored_name));
      }

      const groups = Array.isArray(cardData.filegroups) ? cardData.filegroups as unknown[] : [];
      filegroup = {
        message,
        file_idxs: fileIdxs.slice(),
        created_at: now,
      };
      groups.push(filegroup);
      cardData.filegroups = groups;
      return card;
    });

    return {
      ok: true,
      files: persisted.map((file, index) => ({ ...file, file_idx: fileIdxs[index], chat: false })),
      file_idxs: fileIdxs.slice(),
      filegroup,
    };
  }

  return { uploadCardFile, uploadCardFilesMultiple, readCardStoredFileNames };
}
