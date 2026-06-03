import {
  parseRef,
  serializeRef,
  type KindValueRef,
  type QueueMessage,
} from '../cli/common/storage-interface.js';
import type {
  AsyncBoardPlatformAdapter,
} from '../cli/cloud/index.js';
import { CardCompute } from '../card-compute/index.js';
import { validateCardPreflight as validateStandaloneCardPreflight } from '../card-validation.js';
import { createAsyncBoardConfigStore } from '../cli/cloud/index.js';
import type { BoardRuntimeNonCorePublic } from '../server-runtime/types.js';
import type { CommandInput, CommandResult } from '../cli/common/board-live-cards-public.js';
import type { ComputeNode } from '../card-compute/index.js';
import type {
  AsyncArchiveFactory,
  AsyncAtomicRelayLock,
  AsyncBlobStorage,
  AsyncJournalStorage,
  AsyncKVStorage,
  AsyncQueueStorage,
  AsyncScratchStorage,
} from '../cli/cloud/storage-async-interface.js';
import { createHostedAsyncBoardPlatformAdapter } from '../cli/cloud/index.js';
import { computeStableJsonHashBrowser } from '../cli/browser-api/storage-localstorage-adapters.js';
import { createAsyncChatStorage } from '../cli/common/chat-storage-lib.js';

export interface FirestoreDocumentSnapshotLike {
  readonly exists: boolean;
  readonly id: string;
  data(): Record<string, any> | undefined;
}

export interface FirestoreQuerySnapshotLike {
  readonly docs: FirestoreDocumentSnapshotLike[];
  readonly empty?: boolean;
}

export interface FirestoreTransactionLike {
  get(ref: FirestoreDocumentLike): Promise<FirestoreDocumentSnapshotLike>;
  set(ref: FirestoreDocumentLike, data: Record<string, any>, options?: Record<string, any>): void;
  update(ref: FirestoreDocumentLike, data: Record<string, any>): void;
  delete(ref: FirestoreDocumentLike): void;
}

export interface FirestoreQueryLike {
  get(): Promise<FirestoreQuerySnapshotLike>;
  where(field: string, op: string, value: unknown): FirestoreQueryLike;
  orderBy(field: string, direction?: 'asc' | 'desc'): FirestoreQueryLike;
  limit(count: number): FirestoreQueryLike;
}

export interface FirestoreCollectionLike extends FirestoreQueryLike {
  readonly path: string;
  readonly firestore: FirestoreLike;
  doc(id?: string): FirestoreDocumentLike;
}

export interface FirestoreDocumentLike {
  readonly id: string;
  readonly path: string;
  readonly firestore: FirestoreLike;
  get(): Promise<FirestoreDocumentSnapshotLike>;
  set(data: Record<string, any>, options?: Record<string, any>): Promise<void>;
  update(data: Record<string, any>): Promise<void>;
  delete(): Promise<void>;
  collection(name: string): FirestoreCollectionLike;
  listCollections?(): Promise<FirestoreCollectionLike[]>;
}

export interface FirestoreLike {
  collection(path: string): FirestoreCollectionLike;
  runTransaction<T>(updateFn: (tx: FirestoreTransactionLike) => Promise<T>): Promise<T>;
  batch?(): {
    delete(ref: FirestoreDocumentLike): void;
    commit(): Promise<void>;
  };
}

export interface FirestoreBoardRefs {
  baseRef: KindValueRef;
  boardRuntimeStoreRef: string;
  cardStoreRef: string;
  outputsStoreRef: string;
  queueStoreRef: string;
  scratchStoreRef: string;
  chatStoreRef: string;
  artifactsStoreRef: string;
  fetchedSourcesStoreRef: string;
}

function ok<T>(data: T): CommandResult<T> {
  return { status: 'success', data } as CommandResult<T>;
}

function fail<T = never>(message: string): CommandResult<T> {
  return { status: 'fail', error: message } as CommandResult<T>;
}

function err<T = never>(error: unknown): CommandResult<T> {
  return { status: 'error', error: error instanceof Error ? error.message : String(error) } as CommandResult<T>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeChatCardKey(cardId: string): string {
  return String(cardId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface FirestoreNonCoreExecutorRequest {
  subcommand: string;
  input?: string;
  timeoutMs?: number;
}

export type FirestoreNonCoreExecutorHook = (
  request: FirestoreNonCoreExecutorRequest,
) => Promise<unknown>;

function createFirestoreBoardNonCorePublic(
  adapter: AsyncBoardPlatformAdapter,
  options: FirestoreBoardAdapterOptions = {},
): BoardRuntimeNonCorePublic {
  const configStore = () => createAsyncBoardConfigStore(adapter.kvStorage('config'));
  type SimulateCardCycleResult = {
    cardId: string;
    ok: boolean;
    validation: { isValid: boolean; issues: string[] };
    source_probes: Array<{ bindTo: string; reachable?: unknown; latencyMs?: unknown; error?: string; skipped?: boolean }>;
    projection_errors: Array<{ bindTo: string; key: string; error: string }>;
    fetched_sources: Record<string, unknown>;
    computed_values: Record<string, unknown>;
    compute_errors: Array<{ bindTo: string; error: string }>;
  };

  async function readConfiguredTaskExecutorRef() {
    return await configStore().readTaskExecutorRef().catch(() => undefined);
  }

  async function invokeHostedNonCoreExecutor(
    subcommand: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    if (!options.nonCoreTaskExecutor) {
      throw new Error(`${subcommand} is not supported on the hosted Firestore runtime yet`);
    }
    const result = await options.nonCoreTaskExecutor({
      subcommand,
      ...(payload !== undefined ? { input: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return asRecord(result);
  }

  async function validateCardPreflight(input: CommandInput): Promise<CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>> {
    try {
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('validateCardPreflight requires card JSON object in body') as CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>;
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const cardId = typeof card.id === 'string' ? card.id : '(unknown)';
      const result = validateStandaloneCardPreflight(card);
      const hasSources = Array.isArray(card.source_defs) && card.source_defs.length > 0;
      const issues = [...result.issues];
      if (hasSources) {
        if (options.nonCoreTaskExecutor) {
          for (const src of card.source_defs as Array<Record<string, unknown>>) {
            const bindTo = typeof src.bindTo === 'string' ? src.bindTo : '(unknown)';
            try {
              const parsed = await invokeHostedNonCoreExecutor(
                'validate-source-def',
                src,
                10_000,
              );
              if (parsed.ok !== true && Array.isArray(parsed.errors)) {
                for (const issue of parsed.errors) {
                  if (typeof issue === 'string' && issue) issues.push(`source "${bindTo}": ${issue}`);
                }
              }
            } catch (error) {
              issues.push(`source "${bindTo}": executor validate-source-def failed — ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } else {
          const taskExecutorRef = await readConfiguredTaskExecutorRef();
          if (taskExecutorRef) {
            issues.push('executor-backed source_def preflight is not supported on the hosted Firestore runtime yet');
          }
        }
      }
      return ok({ cardId, isValid: issues.length === 0, issues });
    } catch (error) {
      return err(error) as CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>;
    }
  }

  function evalCardCompute(input: CommandInput): CommandResult<{ cardId: string; ok: boolean; computed_values: Record<string, unknown>; errors: Array<{ bindTo: string; error: string }> }> {
    try {
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('evalCardCompute requires a JSON object in body') as CommandResult<{ cardId: string; ok: boolean; computed_values: Record<string, unknown>; errors: Array<{ bindTo: string; error: string }> }>;
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const cardId = typeof card.id === 'string' ? card.id : '(unknown)';
      const mockFetchedSources = (body['mock-fetched-sources'] ?? {}) as Record<string, unknown>;
      const mockRequires = (body['mock-requires'] ?? {}) as Record<string, unknown>;
      const computeSteps = card.compute as Array<{ bindTo: string; expr: string }> | undefined;
      if (!computeSteps || !Array.isArray(computeSteps) || computeSteps.length === 0) {
        return ok({ cardId, ok: true, computed_values: {}, errors: [] });
      }
      const node: ComputeNode = {
        id: cardId,
        card_data: (card.card_data ?? {}) as Record<string, unknown>,
        requires: mockRequires,
        source_defs: card.source_defs as ComputeNode['source_defs'],
        compute: computeSteps,
      };
      const result = CardCompute.runSync(node, { sourcesData: mockFetchedSources });
      return ok({
        cardId,
        ok: (result.errors ?? []).length === 0,
        computed_values: result.node.computed_values ?? {},
        errors: result.errors ?? [],
      });
    } catch (error) {
      return err(error) as CommandResult<{ cardId: string; ok: boolean; computed_values: Record<string, unknown>; errors: Array<{ bindTo: string; error: string }> }>;
    }
  }

  async function unsupported<T = never>(toolName: string): Promise<CommandResult<T>> {
    await readConfiguredTaskExecutorRef();
    return fail(`${toolName} is not supported on the hosted Firestore runtime yet`);
  }

  async function describeTaskExecutorCapabilities(): Promise<CommandResult> {
    try {
      if (options.nonCoreTaskExecutor) {
        return ok(await invokeHostedNonCoreExecutor('describe-capabilities', undefined, 10_000));
      }
      return await unsupported('describeTaskExecutorCapabilities');
    } catch (error) {
      return err(error);
    }
  }

  async function probeSourcePreflight(input: CommandInput): Promise<CommandResult> {
    try {
      if (!options.nonCoreTaskExecutor) return await unsupported('probeSourcePreflight');
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('probeSourcePreflight requires card JSON object in body');
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const mockProjections = asRecord(body['mock-projections'] ?? {});
      const sourceIdx = input.params?.['sourceIdx'] as number | undefined;
      const sourceDefs = Array.isArray(card.source_defs) ? card.source_defs as Array<Record<string, unknown>> : [];
      if (sourceIdx === undefined) return fail('probeSourcePreflight requires params.sourceIdx');
      if (sourceIdx < 0 || sourceIdx >= sourceDefs.length) {
        return fail(`sourceIdx ${sourceIdx} out of range (card has ${sourceDefs.length} source(s))`);
      }
      const src = sourceDefs[sourceIdx];
      const bindTo = typeof src.bindTo === 'string' ? src.bindTo : 'source';
      const parsed = await invokeHostedNonCoreExecutor(
        'probe-source-preflight',
        { ...src, _projections: mockProjections },
        (src.timeout as number | undefined) ?? 60_000,
      );
      if (parsed.ok !== true) return fail(typeof parsed.error === 'string' ? parsed.error : 'Preflight probe failed');
      return ok({
        bindTo,
        reachable: parsed.reachable,
        latencyMs: parsed.latencyMs,
        ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
      });
    } catch (error) {
      return err(error);
    }
  }

  async function runSourcePreflight(input: CommandInput): Promise<CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>> {
    try {
      if (!options.nonCoreTaskExecutor) return await unsupported('runSourcePreflight') as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>;
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('runSourcePreflight requires card JSON object in body') as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>;
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const mockProjections = asRecord(body['mock-projections'] ?? {});
      const sourceIdx = input.params?.['sourceIdx'] as number | undefined;
      const sourceDefs = Array.isArray(card.source_defs) ? card.source_defs as Array<Record<string, unknown>> : [];
      if (sourceIdx === undefined) return fail('runSourcePreflight requires params.sourceIdx') as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>;
      if (sourceIdx < 0 || sourceIdx >= sourceDefs.length) {
        return fail(`sourceIdx ${sourceIdx} out of range (card has ${sourceDefs.length} source(s))`) as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>;
      }
      const src = sourceDefs[sourceIdx];
      const bindTo = typeof src.bindTo === 'string' ? src.bindTo : 'source';
      const parsed = await invokeHostedNonCoreExecutor(
        'run-source-preflight',
        { ...src, _projections: mockProjections },
        (src.timeout as number | undefined) ?? 60_000,
      );
      if (parsed.ok !== true) {
        return ok({
          bindTo,
          ok: false,
          result: null,
          issues: [typeof parsed.error === 'string' ? parsed.error : 'Preflight run failed'],
        });
      }
      return ok({
        bindTo,
        ok: true,
        result: Object.prototype.hasOwnProperty.call(parsed, 'resultValue') ? parsed.resultValue : null,
        issues: [],
      });
    } catch (error) {
      return err(error) as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>;
    }
  }

  async function simulateCardCycle(input: CommandInput): Promise<CommandResult<SimulateCardCycleResult>> {
    try {
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('simulateCardCycle requires a JSON object in body') as CommandResult<SimulateCardCycleResult>;
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const cardId = typeof card.id === 'string' ? card.id : '(unknown)';
      const mockFetchedSources = asRecord(body['mock-fetched-sources'] ?? {});
      const mockRequires = asRecord(body['mock-requires'] ?? {});

      const validationResult = await validateCardPreflight({ body: { 'card-content': card } });
      const validation = validationResult.status === 'success'
        ? { isValid: validationResult.data.isValid, issues: validationResult.data.issues }
        : { isValid: false, issues: [validationResult.status === 'fail' ? validationResult.error : 'internal error'] };

      const sourceDefs = Array.isArray(card.source_defs) ? card.source_defs as Array<Record<string, unknown>> : [];
      const cardData = asRecord(card.card_data ?? {});
      let enrichedSources: Array<Record<string, unknown>> = [];
      const projectionErrors: Array<{ bindTo: string; key: string; error: string }> = [];
      if (sourceDefs.length > 0) {
        enrichedSources = CardCompute.enrichSourcesSync(sourceDefs as any, { card_data: cardData, requires: mockRequires });
        for (const src of enrichedSources) {
          const projections = src.projections as Record<string, string> | undefined;
          const resolved = src._projections as Record<string, unknown> | undefined;
          if (projections && resolved) {
            for (const key of Object.keys(projections)) {
              if (resolved[key] === undefined) {
                const bindTo = typeof src.bindTo === 'string' ? src.bindTo : '(unknown)';
                projectionErrors.push({ bindTo, key, error: `Projection "${key}" resolved to undefined` });
              }
            }
          }
        }
      }

      const sourceProbes: Array<{ bindTo: string; reachable?: unknown; latencyMs?: unknown; error?: string; skipped?: boolean }> = [];
      const fetchedSources: Record<string, unknown> = { ...mockFetchedSources };
      for (let index = 0; index < enrichedSources.length; index += 1) {
        const src = enrichedSources[index];
        const bindTo = typeof src.bindTo === 'string' ? src.bindTo : `source_${index}`;
        if (!options.nonCoreTaskExecutor) {
          sourceProbes.push({ bindTo, skipped: true, error: 'No task executor configured' });
          continue;
        }
        try {
          const parsed = await invokeHostedNonCoreExecutor(
            'run-source-preflight',
            src,
            (src.timeout as number | undefined) ?? 60_000,
          );
          if (parsed.ok === true && !Object.prototype.hasOwnProperty.call(mockFetchedSources, bindTo) && Object.prototype.hasOwnProperty.call(parsed, 'resultValue')) {
            fetchedSources[bindTo] = parsed.resultValue;
          }
          sourceProbes.push({
            bindTo,
            reachable: parsed.reachable,
            latencyMs: parsed.latencyMs,
            ...(parsed.ok === true ? {} : { error: typeof parsed.error === 'string' ? parsed.error : 'Preflight run failed' }),
          });
        } catch {
          sourceProbes.push({ bindTo, skipped: true, error: 'Executor does not support run-source-preflight' });
        }
      }

      const computeSteps = card.compute as Array<{ bindTo: string; expr: string }> | undefined;
      let computedValues: Record<string, unknown> = {};
      let computeErrors: Array<{ bindTo: string; error: string }> = [];
      if (computeSteps && Array.isArray(computeSteps) && computeSteps.length > 0) {
        const node: ComputeNode = {
          id: cardId,
          card_data: cardData,
          requires: mockRequires,
          source_defs: card.source_defs as ComputeNode['source_defs'],
          compute: computeSteps,
        };
        const result = CardCompute.runSync(node, { sourcesData: fetchedSources });
        computedValues = result.node.computed_values ?? {};
        computeErrors = result.errors ?? [];
      }

      return ok({
        cardId,
        ok: validation.isValid && projectionErrors.length === 0 && computeErrors.length === 0 && sourceProbes.every((entry) => !entry.error),
        validation,
        source_probes: sourceProbes,
        projection_errors: projectionErrors,
        fetched_sources: fetchedSources,
        computed_values: computedValues,
        compute_errors: computeErrors,
      });
    } catch (error) {
      return err(error) as CommandResult<SimulateCardCycleResult>;
    }
  }

  return {
    describeTaskExecutorCapabilities,
    validateCardPreflight,
    evalCardCompute,
    probeSourcePreflight,
    runSourcePreflight,
    simulateCardCycle,
  };
}

export interface FirestoreQueueStorageOptions {
  defaultVisibilityMs?: number;
}

export interface FirestoreBoardAdapterOptions {
  refs?: Partial<FirestoreBoardRefs>;
  holderId?: string;
  requestProcessAccumulated?: () => void | Promise<void>;
  publishBoardChangeNotifications?: (notifications: unknown[]) => void | Promise<void>;
  nonCoreTaskExecutorRef?: import('../cli/common/execution-interface.js').ExecutionRef;
  nonCoreTaskExecutor?: FirestoreNonCoreExecutorHook;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stableHash16(value: unknown): string {
  return computeStableJsonHashBrowser(value).slice(0, 16);
}

function uuidLike(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function encodeDocId(key: string): string {
  return base64UrlEncode(String(key));
}

function lexicalId(): string {
  const ts = String(Date.now()).padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}-${rand}`;
}

function tryParseRef(ref: string): KindValueRef | null {
  try {
    return parseRef(ref);
  } catch {
    return null;
  }
}

function requireCollectionPath(ref: string, fallback: string): string {
  const parsed = tryParseRef(ref);
  if (parsed?.kind === 'firestore' && parsed.value) return parsed.value;
  return fallback;
}

function stripUndefinedDeep<T>(value: T): T {
  if (value === undefined) return null as T;
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedDeep(entry === undefined ? null : entry)) as T;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedDeep(entry)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function boardDoc(db: FirestoreLike, boardId: string): FirestoreDocumentLike {
  return db.collection('boards').doc(boardId);
}

function boardCollection(db: FirestoreLike, boardId: string, name: string): FirestoreCollectionLike {
  return boardDoc(db, boardId).collection(name);
}

export function makeFirestoreRef(path: string): KindValueRef {
  return { kind: 'firestore', value: String(path) };
}

export function serializeFirestoreRef(path: string): string {
  return serializeRef(makeFirestoreRef(path));
}

export function createFirestoreBoardRefs(boardId: string): FirestoreBoardRefs {
  return {
    baseRef: makeFirestoreRef(`boards/${boardId}`),
    boardRuntimeStoreRef: serializeFirestoreRef(`boards/${boardId}/runtime-board`),
    cardStoreRef: serializeFirestoreRef(`boards/${boardId}/cards`),
    outputsStoreRef: serializeFirestoreRef(`boards/${boardId}/runtime-out`),
    queueStoreRef: serializeFirestoreRef(`boards/${boardId}/runtime`),
    scratchStoreRef: serializeFirestoreRef(`boards/${boardId}/scratch`),
    chatStoreRef: serializeFirestoreRef(`boards/${boardId}/chat`),
    artifactsStoreRef: serializeFirestoreRef(`boards/${boardId}/files`),
    fetchedSourcesStoreRef: serializeFirestoreRef(`boards/${boardId}/sources`),
  };
}

export function createFirestoreKvStorage(col: FirestoreCollectionLike): AsyncKVStorage {
  return {
    async read(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      return snap.exists ? (snap.data()?.value ?? null) : null;
    },
    async write(key: string, value: unknown) {
      await col.doc(encodeDocId(key)).set(stripUndefinedDeep({ k: key, value }));
    },
    async delete(key: string) {
      await col.doc(encodeDocId(key)).delete();
    },
    async listKeys(prefix = '') {
      const query = prefix
        ? col.where('k', '>=', prefix).where('k', '<', `${prefix}\uf8ff`).orderBy('k')
        : col.orderBy('k');
      const snap = await query.get();
      return snap.docs.map((doc) => doc.data()?.k ?? doc.id);
    },
  };
}

export function createFirestoreJournalStorage(col: FirestoreCollectionLike): AsyncJournalStorage {
  return {
    async append(payload: unknown) {
      const id = lexicalId();
      await col.doc(id).set(stripUndefinedDeep({ id, createdAt: new Date().toISOString(), payload }));
      return { id, payload };
    },
    async readAll() {
      const snap = await col.orderBy('id').get();
      return snap.docs.map((doc) => {
        const data = doc.data() ?? {};
        return { id: String(data.id ?? doc.id), payload: data.payload };
      });
    },
    async readAfter(cursor: string | null) {
      const query = cursor
        ? col.where('id', '>', cursor).orderBy('id')
        : col.orderBy('id');
      const snap = await query.get();
      const entries = snap.docs.map((doc) => {
        const data = doc.data() ?? {};
        return { id: String(data.id ?? doc.id), payload: data.payload };
      });
      return {
        entries,
        newCursor: entries.length > 0 ? entries[entries.length - 1].id : cursor,
      };
    },
    async clear() {
      const snap = await col.get();
      if (typeof col.firestore.batch === 'function') {
        const batch = col.firestore.batch();
        for (const doc of snap.docs) batch.delete(col.doc(doc.id));
        await batch.commit();
        return;
      }
      await Promise.all(snap.docs.map((doc) => col.doc(doc.id).delete()));
    },
  };
}

export function createFirestoreBlobStorage(col: FirestoreCollectionLike): AsyncBlobStorage {
  return {
    async read(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      return snap.exists ? (snap.data()?.content ?? null) : null;
    },
    async write(key: string, content: string) {
      await col.doc(encodeDocId(key)).set({ k: key, content });
    },
    async exists(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      return snap.exists;
    },
    async remove(key: string) {
      await col.doc(encodeDocId(key)).delete();
    },
    async readBytes(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      if (!snap.exists) return null;
      const data = snap.data() ?? {};
      if (typeof data.bytesBase64 === 'string') return base64ToBytes(data.bytesBase64);
      if (typeof data.content === 'string') return new TextEncoder().encode(data.content);
      return null;
    },
    async writeBytes(key: string, bytes: Uint8Array) {
      await col.doc(encodeDocId(key)).set({
        k: key,
        bytesBase64: bytesToBase64(bytes),
      });
    },
    async listKeys(prefix = '') {
      const query = prefix
        ? col.where('k', '>=', prefix).where('k', '<', `${prefix}\uf8ff`).orderBy('k')
        : col.orderBy('k');
      const snap = await query.get();
      return snap.docs.map((doc) => doc.data()?.k ?? doc.id);
    },
    async stat(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      if (!snap.exists) return null;
      const data = snap.data() ?? {};
      const size = typeof data.bytesBase64 === 'string'
        ? Math.floor((data.bytesBase64.length * 3) / 4)
        : typeof data.content === 'string'
          ? data.content.length
          : 0;
      return { key, size, contentType: String(data.contentType ?? 'application/octet-stream') };
    },

    async renameKey(from: string, to: string): Promise<boolean> {
      const snap = await col.doc(encodeDocId(from)).get();
      if (!snap.exists) return false;
      const data = snap.data() ?? {};
      await col.doc(encodeDocId(to)).set({ ...data, k: to });
      await col.doc(encodeDocId(from)).delete();
      return true;
    },
  };
}

export function createFirestoreScratchStorage(col: FirestoreCollectionLike): AsyncScratchStorage {
  const blob = createFirestoreBlobStorage(col);
  return {
    ...blob,
    async getUniqueKey(prefix = 'scratch-', suffix = '') {
      return `${prefix}${lexicalId()}${suffix}`;
    },
    async create(data: string, prefix = 'scratch-', suffix = '') {
      const key = `${prefix}${lexicalId()}${suffix}`;
      await blob.write(key, data);
      return key;
    },
    keyRef(key: string) {
      return makeFirestoreRef(`${col.path}/${encodeDocId(key)}`);
    },
    config: {
      async get(k: string) {
        const raw = await blob.read(`__config__/${k}`);
        if (raw == null) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      },
      async set(k: string, v: unknown) {
        await blob.write(`__config__/${k}`, JSON.stringify(v));
      },
    },
  };
}

export function createFirestoreArchiveFactory(db: FirestoreLike, boardId: string): AsyncArchiveFactory {
  const doc = boardDoc(db, boardId);
  return {
    stream(name: string) {
      return createFirestoreJournalStorage(doc.collection(`archive-stream-${name}`));
    },
    blob(name: string) {
      return createFirestoreBlobStorage(doc.collection(`archive-blob-${name}`));
    },
    async listStreams(prefix = '') {
      if (typeof doc.listCollections !== 'function') return [];
      const cols = await doc.listCollections();
      return cols
        .map((col) => col.path.split('/').at(-1) ?? '')
        .filter((name) => name.startsWith(`archive-stream-${prefix}`))
        .map((name) => name.slice('archive-stream-'.length));
    },
    async listBlobs(prefix = '') {
      if (typeof doc.listCollections !== 'function') return [];
      const cols = await doc.listCollections();
      return cols
        .map((col) => col.path.split('/').at(-1) ?? '')
        .filter((name) => name.startsWith(`archive-blob-${prefix}`))
        .map((name) => name.slice('archive-blob-'.length));
    },
    config: {
      async get(k: string) {
        const snap = await doc.collection('archive-config').doc('main').get();
        return snap.exists ? (snap.data()?.[k] ?? null) : null;
      },
      async set(k: string, v: unknown) {
        await doc.collection('archive-config').doc('main').set(stripUndefinedDeep({ [k]: v }), { merge: true });
      },
    },
  };
}

export function createFirestoreLock(lockDoc: FirestoreDocumentLike, opts: { holderId?: string; ttlMs?: number } = {}): AsyncAtomicRelayLock {
  const holderId = opts.holderId ?? uuidLike();
  const ttlMs = opts.ttlMs ?? 30_000;

  return {
    async tryAcquire() {
      try {
        await lockDoc.firestore.runTransaction(async (tx) => {
          const snap = await tx.get(lockDoc);
          const nowIso = new Date().toISOString();
          if (snap.exists) {
            const data = snap.data() ?? {};
            if (data.held === true && typeof data.expiresAt === 'string' && data.expiresAt > nowIso) {
              throw Object.assign(new Error('locked'), { code: 'locked' });
            }
          }
          tx.set(lockDoc, {
            held: true,
            holderId,
            acquiredAt: nowIso,
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          });
        });
      } catch (error: any) {
        if (error?.code === 'locked') return null;
        throw error;
      }

      return async () => {
        try {
          await lockDoc.firestore.runTransaction(async (tx) => {
            const snap = await tx.get(lockDoc);
            if (!snap.exists) return;
            const data = snap.data() ?? {};
            if (data.holderId === holderId) tx.update(lockDoc, { held: false, holderId: null });
          });
        } catch {
          // best-effort release
        }
      };
    },
  };
}

export function createFirestoreQueueStorage(col: FirestoreCollectionLike, opts: FirestoreQueueStorageOptions = {}): AsyncQueueStorage {
  const defaultVisibilityMs = opts.defaultVisibilityMs ?? 30_000;

  return {
    async enqueue<T>(body: T) {
      const id = lexicalId();
      const nowIso = new Date().toISOString();
      await col.doc(id).set(stripUndefinedDeep({
        id,
        body,
        enqueuedAt: nowIso,
        attempt: 0,
        staged: false,
        visibleAfter: nowIso,
        leaseToken: null,
        leaseExpiresAt: null,
        dead: false,
        deadReason: null,
      }));
      return { id, body, enqueuedAt: nowIso, attempt: 0 };
    },
    async enqueueMany<T>(bodies: T[]) {
      const queued = [] as QueueMessage<T>[];
      for (const body of bodies) queued.push(await this.enqueue(body));
      return queued;
    },
    async enqueueIfAbsent<T>(body: T, dedupKey: string) {
      const existing = await col.where('dedupKey', '==', dedupKey).where('dead', '==', false).limit(1).get();
      if (existing.docs.length > 0) return null;
      const id = lexicalId();
      const nowIso = new Date().toISOString();
      await col.doc(id).set(stripUndefinedDeep({
        id,
        body,
        dedupKey,
        enqueuedAt: nowIso,
        attempt: 0,
        staged: false,
        visibleAfter: nowIso,
        leaseToken: null,
        leaseExpiresAt: null,
        dead: false,
        deadReason: null,
      }));
      return { id, body, enqueuedAt: nowIso, attempt: 0 };
    },
    async stage<T>(body: T, opts: { dedupKey?: string } = {}) {
      if (opts.dedupKey) {
        const existing = await col.where('dedupKey', '==', opts.dedupKey).where('dead', '==', false).limit(1).get();
        if (existing.docs.length > 0) return null;
      }
      const id = lexicalId();
      const nowIso = new Date().toISOString();
      await col.doc(id).set(stripUndefinedDeep({
        id,
        body,
        dedupKey: opts.dedupKey,
        enqueuedAt: nowIso,
        attempt: 0,
        staged: true,
        visibleAfter: null,
        leaseToken: null,
        leaseExpiresAt: null,
        dead: false,
        deadReason: null,
      }));
      return { id, body, enqueuedAt: nowIso, attempt: 0 };
    },
    async commitStaged(messageId: string) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error('missing');
          const data = snap.data() ?? {};
          if (data.dead === true || data.staged !== true) throw new Error('not-staged');
          tx.update(ref, {
            staged: false,
            enqueuedAt: new Date().toISOString(),
            attempt: 0,
            visibleAfter: new Date().toISOString(),
          });
        });
        return true;
      } catch {
        return false;
      }
    },
    async discardStaged(messageId: string, reason?: string) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error('missing');
          const data = snap.data() ?? {};
          if (data.dead === true || data.staged !== true) throw new Error('not-staged');
          tx.update(ref, {
            staged: false,
            dead: true,
            deadReason: reason ?? 'discarded',
          });
        });
        return true;
      } catch {
        return false;
      }
    },
    async peekStaged(prefix = '') {
      const snap = await col.where('dead', '==', false).where('staged', '==', true).orderBy('enqueuedAt').get();
      return snap.docs
        .map((doc) => doc.data() ?? {})
        .filter((entry) => !prefix || String(entry.id ?? '').startsWith(prefix))
        .map((entry) => ({
          id: String(entry.id ?? ''),
          body: entry.body,
          enqueuedAt: String(entry.enqueuedAt ?? ''),
          attempt: Number(entry.attempt ?? 0),
        }));
    },
    async lease(options: { max?: number; visibilityMs?: number } = {}) {
      const max = Math.max(1, Number(options.max ?? 1));
      const visibilityMs = Math.max(1, Number(options.visibilityMs ?? defaultVisibilityMs));
      const nowIso = new Date().toISOString();
      const snap = await col
        .where('dead', '==', false)
        .where('staged', '==', false)
        .where('visibleAfter', '<=', nowIso)
        .orderBy('visibleAfter')
        .limit(max * 4)
        .get();
      const leased: Array<Record<string, any>> = [];
      for (const doc of snap.docs) {
        if (leased.length >= max) break;
        const docRef = col.doc(doc.id);
        try {
          let leasedMessage: Record<string, any> | null = null;
          await col.firestore.runTransaction(async (tx) => {
            const fresh = await tx.get(docRef);
            if (!fresh.exists) throw new Error('gone');
            const data = fresh.data() ?? {};
            const txNowIso = new Date().toISOString();
            if (data.dead === true) throw new Error('dead');
            if (data.staged === true) throw new Error('staged');
            if (typeof data.visibleAfter === 'string' && data.visibleAfter > txNowIso) throw new Error('hidden');
            if (data.leaseToken && typeof data.leaseExpiresAt === 'string' && data.leaseExpiresAt > txNowIso) throw new Error('leased');
            const leaseToken = uuidLike();
            const leaseExpiresAt = new Date(Date.now() + visibilityMs).toISOString();
            const attempt = Number(data.attempt ?? 0) + 1;
            tx.update(docRef, { leaseToken, leaseExpiresAt, attempt });
            leasedMessage = {
              id: String(data.id ?? doc.id),
              body: data.body,
              enqueuedAt: String(data.enqueuedAt ?? txNowIso),
              attempt,
              leaseToken,
              leaseExpiresAt,
            };
          });
          if (leasedMessage) leased.push(leasedMessage);
        } catch {
          // race or hidden; skip
        }
      }
      return leased as any;
    },
    async ack(messageId: string, leaseToken: string) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const data = snap.data() ?? {};
          if (data.leaseToken !== leaseToken) throw new Error('token mismatch');
          tx.delete(ref);
        });
        return true;
      } catch {
        return false;
      }
    },
    async nack(messageId: string, leaseToken: string, opts: { dead?: boolean; reason?: string } = {}) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const data = snap.data() ?? {};
          if (data.leaseToken !== leaseToken) throw new Error('token mismatch');
          if (opts.dead === true) {
            tx.update(ref, {
              dead: true,
              deadReason: opts.reason ?? 'nacked',
              leaseToken: null,
              leaseExpiresAt: null,
            });
          } else {
            tx.update(ref, {
              leaseToken: null,
              leaseExpiresAt: null,
              visibleAfter: new Date().toISOString(),
            });
          }
        });
        return true;
      } catch {
        return false;
      }
    },
    async peekActive(prefix = '') {
      const snap = await col.where('dead', '==', false).where('staged', '==', false).orderBy('enqueuedAt').get();
      return snap.docs
        .map((doc) => doc.data() ?? {})
        .filter((entry) => !prefix || String(entry.id ?? '').startsWith(prefix))
        .map((entry) => ({
          id: String(entry.id ?? ''),
          body: entry.body,
          enqueuedAt: String(entry.enqueuedAt ?? ''),
          attempt: Number(entry.attempt ?? 0),
        }));
    },
    async peekDeadLetter(prefix = '') {
      const snap = await col.where('dead', '==', true).orderBy('enqueuedAt').get();
      return snap.docs
        .map((doc) => doc.data() ?? {})
        .filter((entry) => !prefix || String(entry.id ?? '').startsWith(prefix))
        .map((entry) => ({
          id: String(entry.id ?? ''),
          body: entry.body,
          enqueuedAt: String(entry.enqueuedAt ?? ''),
          attempt: Number(entry.attempt ?? 0),
          reason: entry.deadReason,
        }));
    },
  };
}

export function createFirestoreBoardAdapter(
  db: FirestoreLike,
  boardId: string,
  options: FirestoreBoardAdapterOptions = {},
): AsyncBoardPlatformAdapter {
  return createHostedAsyncBoardPlatformAdapter({
    boardId,
    kvStorage(namespace) {
      return createFirestoreKvStorage(boardCollection(db, boardId, `kv-${namespace || 'root'}`));
    },
    kvStorageForRef(ref) {
      return createFirestoreKvStorage(db.collection(requireCollectionPath(ref, `boards/${boardId}/kv-root`)));
    },
    blobStorage(namespace) {
      return createFirestoreBlobStorage(boardCollection(db, boardId, `blobs-${namespace || 'root'}`));
    },
    blobStorageForRef(ref) {
      return createFirestoreBlobStorage(db.collection(requireCollectionPath(ref, `boards/${boardId}/blobs-root`)));
    },
    chatStorageForRef(ref) {
      const root = requireCollectionPath(ref, `boards/${boardId}/chat`);
      return createAsyncChatStorage(
        (cardId) => createFirestoreJournalStorage(db.collection(`${root}-journal-${safeChatCardKey(cardId)}`)),
        createFirestoreKvStorage(db.collection(`${root}-kv`)),
      );
    },
    queueStoreRef: createFirestoreBoardRefs(boardId).queueStoreRef,
    queueStorageForRef(ref, lane) {
      const root = requireCollectionPath(ref, `boards/${boardId}/runtime`);
      return createFirestoreQueueStorage(db.collection(`${root}-${lane}`));
    },
    scratchStorage() {
      return createFirestoreScratchStorage(boardCollection(db, boardId, 'scratch'));
    },
    scratchStorageForRef(ref) {
      return createFirestoreScratchStorage(db.collection(requireCollectionPath(ref, `boards/${boardId}/scratch`)));
    },
    archiveFactory() {
      return createFirestoreArchiveFactory(db, boardId);
    },
    archiveFactoryForRef(ref) {
      const parsed = tryParseRef(ref);
      const altBoardId = parsed?.kind === 'firestore-board' ? parsed.value : boardId;
      return createFirestoreArchiveFactory(db, altBoardId);
    },
    journalStorage() {
      return createFirestoreJournalStorage(boardCollection(db, boardId, 'journal'));
    },
    journalStorageForRef(ref) {
      const root = requireCollectionPath(ref, `boards/${boardId}/runtime-board`);
      return createFirestoreJournalStorage(db.collection(`${root}-journal`));
    },
    lock: createFirestoreLock(boardCollection(db, boardId, 'locks').doc('board-lock'), {
      holderId: options.holderId,
    }),
    hashFn(value) {
      return stableHash16(value);
    },
    genId() {
      return lexicalId();
    },
    supportsDirectSourceOutput(ref) {
      return ref.howToRun === 'queue-storage' || ref.howToRun === 'http:post';
    },
    requestProcessAccumulated: options.requestProcessAccumulated,
    publishBoardChangeNotifications: options.publishBoardChangeNotifications as any,
    onWarn: (msg) => console.warn(`[firestore-board-adapter:${boardId}] ${msg}`),
  });
}

export function createFirestoreBoardRuntimeBundle(db: FirestoreLike, boardId: string, options: FirestoreBoardAdapterOptions = {}) {
  const refs = {
    ...createFirestoreBoardRefs(boardId),
    ...(options.refs ?? {}),
  };
  const boardAdapter = createFirestoreBoardAdapter(db, boardId, options);
  return {
    refs,
    boardAdapter,
    nonCore: createFirestoreBoardNonCorePublic(boardAdapter, options),
  };
}
