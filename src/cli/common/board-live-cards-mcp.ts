/**
 * board-live-cards-mcp.ts
 *
 * Platform-free MCP-oriented facade for board-live-cards.
 *
 * This layer preserves the wrapper-script-visible tool semantics while using
 * the existing public library surfaces instead of shelling out to CLIs.
 */

import type {
  CommandResult,
} from './board-live-cards-public.js';
import type { ChatStorePublic } from './chat-store-lib-public.js';
import type { ChatRecord } from './chat-storage-lib.js';
import type { LiveCard } from './board-live-cards-lib.js';
import { CardCompute } from '../../card-compute/index.js';

type UnknownRecord = Record<string, unknown>;
type Awaitable<T> = T | Promise<T>;

export interface BoardLiveCardsMcpFileDownloadDescriptor {
  cardId: string;
  fileIdx: number;
  downloadUrl: string;
  name?: string;
  stored_name?: string;
  mime_type?: string;
  size?: number;
  uploaded_at?: string;
}

export interface BoardLiveCardsMcpDiscoverSourceKindsResult {
  version?: unknown;
  commonSourceFields: UnknownRecord;
  sourceKinds: UnknownRecord;
}

export interface BoardLiveCardsMcpBoardStatusCard {
  'card-id': string | null;
  status: unknown;
  error: unknown;
  requires: unknown[];
  requires_satisfied: unknown[];
  requires_missing: unknown[];
  provides_declared: unknown[];
  provides_runtime: unknown[];
}

export interface BoardLiveCardsMcpBoardStatusResult {
  meta: UnknownRecord;
  summary: {
    card_count: number;
    completed: number;
    eligible: number;
    pending: number;
    blocked: number;
    in_progress: number;
    failed: number;
    unresolved: number;
  };
  cards: BoardLiveCardsMcpBoardStatusCard[];
}

export interface BoardLiveCardsMcpRenderedViewElement {
  id: string;
  kind: unknown;
  label: unknown;
  visible: boolean;
  bind?: string;
  columns?: unknown[];
  maxRows?: number;
  resolved?: unknown;
}

export interface BoardLiveCardsMcpRenderedView {
  layout: unknown;
  features: unknown;
  elements: BoardLiveCardsMcpRenderedViewElement[];
}

export interface BoardLiveCardsMcpInspectCardDefinitionAndRuntimeResult {
  cardId: string;
  card_status_in_board: UnknownRecord;
  card_definition_and_static_data: UnknownRecord;
  refs_for_fetched_source_files: Record<string, string>;
  runtime_data: {
    requires: Record<string, unknown>;
    provides: Record<string, unknown>;
    computed_values: UnknownRecord;
    rendered_view: BoardLiveCardsMcpRenderedView;
  };
}

export interface BoardLiveCardsMcpInspectChatMessagesResult {
  cardId: string;
  messages: Array<ChatRecord & { retrieval_hint?: string; payload?: UnknownRecord }>;
}

export interface BoardLiveCardsMcpManageUpsertCardFailureResult {
  status: 'fail';
  step: 'validate';
  validation: unknown;
}

export interface BoardLiveCardsMcpManageUpsertCardSuccessResult {
  status: 'success';
  data: {
    validation: unknown;
    card_saved: unknown;
    board_result: unknown;
  };
}

export type BoardLiveCardsMcpManageUpsertCardResult =
  | BoardLiveCardsMcpManageUpsertCardFailureResult
  | BoardLiveCardsMcpManageUpsertCardSuccessResult;

export interface BoardLiveCardsMcpManageAddChatEntryAndAnyAttachmentsResult {
  status: 'success';
  data: {
    cardId: string;
    id: string;
    role: string;
    turn: string;
    files: Array<Record<string, unknown>>;
  };
}

export interface BoardLiveCardsMcpManageAddChatAttachmentResult {
  status: 'success';
  data: {
    cardId: string;
    turn: string;
    files: Array<Record<string, unknown>>;
  };
}

export interface BoardLiveCardsMcpPreflightRunOneCycleResult {
  status: 'success';
  data: {
    cardId: string;
    ok: boolean;
    issues: string[];
    provides_outputs: Record<string, unknown>;
    rendered_view: BoardLiveCardsMcpRenderedView;
  };
}

export interface BoardLiveCardsMcpPreflightMaterializeResult {
  status: 'success';
  data: {
    cardId: string;
    ok: boolean;
    computed_values: UnknownRecord;
    errors: Array<{ bindTo: string; error: string }>;
    provides_outputs: Record<string, unknown>;
    rendered_view: BoardLiveCardsMcpRenderedView;
  };
}

export interface BoardLiveCardsMcpBoardDeps {
  status(input: {}): Awaitable<CommandResult>;
  getOutputsDataObject(input: { params: { key: string } }): Awaitable<CommandResult>;
  getOutputsComputedValues(input: { params: { key: string } }): Awaitable<CommandResult>;
  getOutputsFetchedSources(input: { params: { key: string } }): Awaitable<CommandResult<Record<string, string>>>;
  removeCard(input: { params: { id: string } }): Awaitable<CommandResult>;
  upsertCard(input: { params: { cardId: string; restart?: boolean } }): Awaitable<CommandResult>;
}

export interface BoardLiveCardsMcpCardStoreDeps {
  get(input: { params?: { id?: string } }): Awaitable<CommandResult<{ cards?: Array<Record<string, unknown>> }>>;
  set(input: { body?: unknown }): Awaitable<CommandResult>;
  del(input: { params?: { id?: string }; body?: { ids?: string[] } }): Awaitable<CommandResult>;
  patch(input: { params?: { id?: string; path?: string }; body?: unknown }): Awaitable<CommandResult>;
  appendFiles?(input: { params?: { id?: string }; body?: unknown }): Awaitable<CommandResult>;
}

export interface BoardLiveCardsMcpNonCoreDeps {
  describeTaskExecutorCapabilities(input: {}): Promise<CommandResult>;
  validateCardPreflight(input: { body: unknown }): Promise<CommandResult>;
  evalCardCompute(input: { body: unknown }): CommandResult<{
    cardId: string;
    ok: boolean;
    computed_values: Record<string, unknown>;
    errors: Array<{ bindTo: string; error: string }>;
  }>;
  probeSourcePreflight(input: { params: { sourceIdx: number }; body: unknown }): Promise<CommandResult>;
  runSourcePreflight(input: { params: { sourceIdx: number }; body: unknown }): Promise<CommandResult>;
  simulateCardCycle(input: { body: unknown }): Promise<CommandResult>;
}

export interface BoardLiveCardsMcpDeps {
  board: BoardLiveCardsMcpBoardDeps;
  nonCore: BoardLiveCardsMcpNonCoreDeps;
  cardStore: BoardLiveCardsMcpCardStoreDeps;
  chatStore: ChatStorePublic;
  processAccumulated?: () => Awaitable<CommandResult>;
  sourceFetchDone?: (args: { token: string; ref: string }) => Awaitable<CommandResult>;
  sourceFetchFailed?: (args: { token: string; reason: string }) => Awaitable<CommandResult>;
  uploadCardFile(args: { cardId: string; fileName: string; contentType: string; bytes: Uint8Array; suppressChatRecordWrite?: boolean }): Awaitable<{ ok: true; file: Record<string, unknown>; file_idx?: number | null }>;
  buildFileDownloadUrl(args: { cardId: string; fileIdx: number; storedName?: string | null }): string;
  readFetchedSourceJsonByRef?(args: { cardId: string; ref: string }): unknown | null;
}

export interface BoardLiveCardsMcp {
  listRuntimeCards(): Promise<LiveCard[]>;
  discoverSourceKinds(): Promise<BoardLiveCardsMcpDiscoverSourceKindsResult>;
  inspectBoardRuntimeStatus(): Promise<BoardLiveCardsMcpBoardStatusResult>;
  inspectCardDefinitionAndRuntime(args: { cardId: string }): Promise<BoardLiveCardsMcpInspectCardDefinitionAndRuntimeResult>;
  inspectChatMessagesOnCards(args: { cardId: string; lastUserTurns?: number; tail?: number; turnId?: string; allTurns?: boolean; tailTurnsBeforeId?: string }): Promise<BoardLiveCardsMcpInspectChatMessagesResult>;
  inspectFileContents(args: { cardId: string; fileIdx: number }): Promise<BoardLiveCardsMcpFileDownloadDescriptor>;
  preflightValidateCandidateCardDefinition(args: { candidateCardContent: UnknownRecord }): Promise<unknown>;
  preflightMaterializeCandidateCard(args: {
    candidateCardContent: UnknownRecord;
    mockRequires: UnknownRecord;
    mockFetchedSources: UnknownRecord;
  }): BoardLiveCardsMcpPreflightMaterializeResult | CommandResult;
  preflightProbeSingleSourceInCandidateCard(args: {
    candidateCardContent: UnknownRecord;
    mockProjections: UnknownRecord;
    sourceIdx: number;
  }): Promise<unknown>;
  preflightRunSingleSourceInCandidateCard(args: {
    candidateCardContent: UnknownRecord;
    mockProjections: UnknownRecord;
    sourceIdx: number;
  }): Promise<unknown>;
  preflightRunSingleSourceInLiveCard(args: {
    cardId: string;
    sourceIdx: number;
    mockRequires: UnknownRecord;
  }): Promise<unknown>;
  preflightRunOneCycleWithCandidateCard(args: {
    candidateCardContent: UnknownRecord;
    mockRequires: UnknownRecord;
  }): Promise<BoardLiveCardsMcpPreflightRunOneCycleResult>;
  manageReadCard(args: { cardId: string }): Promise<LiveCard[]>;
  manageAddChatAttachment(args: {
    cardId: string;
    role?: string;
    turn?: string;
    files?: unknown[];
  }): Promise<BoardLiveCardsMcpManageAddChatAttachmentResult>;
  manageAddChatEntryAndAnyAttachments(args: {
    cardId: string;
    role: string;
    text?: string;
    turn?: string;
    files?: unknown[];
  }): Promise<BoardLiveCardsMcpManageAddChatEntryAndAnyAttachmentsResult>;
  managePatchCard(args: { cardId: string; patch: UnknownRecord }, opts?: { allowControlplaneOnlyCards?: boolean }): Promise<BoardLiveCardsMcpManageUpsertCardResult>;
  manageUpsertCard(args: { cardId: string; candidateCardContent: UnknownRecord }, opts?: { allowControlplaneOnlyCards?: boolean }): Promise<BoardLiveCardsMcpManageUpsertCardResult>;
  manageRemoveCard(args: { cardId: string }, opts?: { allowControlplaneOnlyCards?: boolean }): Promise<unknown>;
  adminReadCard(args: { cardId: string }): Promise<LiveCard[]>;
  adminUpsertCard(args: { cardId: string; candidateCardContent: UnknownRecord }): Promise<BoardLiveCardsMcpManageUpsertCardResult>;
  getChatProcessing(args: { cardId: string }): Promise<{ cardId: string; active: boolean }>;
  setChatProcessing(args: { cardId: string; active: boolean }): Promise<{ cardId: string; active: boolean }>;
  webhookProcessAccumulated(): Promise<CommandResult<{ runtime_result: unknown }>>;
  webhookSourceFetchDone(args: { token: string; ref: string }): Promise<CommandResult<{ token: string; ref: string; runtime_result: unknown }>>;
  webhookSourceFetchFailed(args: { token: string; reason: string }): Promise<CommandResult<{ token: string; reason: string; runtime_result: unknown }>>;
}

function expectSuccess<T>(result: CommandResult<T>, commandName: string): T {
  if (result?.status === 'success') {
    return Object.prototype.hasOwnProperty.call(result, 'data')
      ? (result as { data: T }).data
      : (undefined as T);
  }
  if (result?.status === 'fail' || result?.status === 'error') {
    throw new Error(result.error || `${commandName} failed`);
  }
  throw new Error(`${commandName} returned an unexpected response`);
}

function expectSuccessData<T>(result: CommandResult<T>, commandName: string): T {
  if (result?.status === 'success' && Object.prototype.hasOwnProperty.call(result, 'data')) {
    return (result as { status: 'success'; data: T }).data;
  }
  if (result?.status === 'success') {
    throw new Error(`${commandName} returned success without data`);
  }
  if (result?.status === 'fail' || result?.status === 'error') {
    throw new Error(result.error || `${commandName} failed`);
  }
  throw new Error(`${commandName} returned an unexpected response`);
}

function ensureRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function ensureArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getAtPath(objectValue: unknown, ref: string | undefined): unknown {
  if (typeof ref !== 'string' || ref.length === 0) {
    return undefined;
  }

  let target: unknown = objectValue;
  let pathRef = ref;
  if (pathRef.startsWith('fetched_sources.')) {
    target = ensureRecord(objectValue).fetched_sources;
    pathRef = pathRef.slice('fetched_sources.'.length);
  }

  for (const segment of pathRef.split('.')) {
    if (target == null || typeof target !== 'object') {
      return undefined;
    }
    target = (target as UnknownRecord)[segment];
  }

  return target;
}

function materializeView(card: UnknownRecord, runtimeNode: UnknownRecord): BoardLiveCardsMcpRenderedView {
  const view = ensureRecord(card.view);
  const elements = ensureArray(view.elements);

  return {
    layout: view.layout,
    features: view.features,
    elements: elements.map((element, index) => {
      const elementObj = ensureRecord(element);
      const dataObj = ensureRecord(elementObj.data);
      const visible = typeof elementObj.visible === 'string'
        ? Boolean(getAtPath(runtimeNode, elementObj.visible))
        : true;
      const bind = typeof dataObj.bind === 'string' ? dataObj.bind : undefined;
      const maxRows = typeof dataObj.maxRows === 'number' ? dataObj.maxRows : undefined;
      const resolved = bind ? getAtPath(runtimeNode, bind) : undefined;
      const model: BoardLiveCardsMcpRenderedViewElement = {
        id: typeof elementObj.id === 'string' && elementObj.id ? elementObj.id : `element-${index}`,
        kind: elementObj.kind,
        label: elementObj.label,
        visible,
      };

      if (resolved !== undefined) {
        model.resolved = Array.isArray(resolved) && typeof maxRows === 'number'
          ? resolved.slice(0, maxRows)
          : resolved;
      }

      return model;
    }),
  };
}

function materializeProvidesOutputs(card: UnknownRecord, runtimeNode: UnknownRecord): Record<string, unknown> {
  const cardId = typeof card.id === 'string' && card.id ? card.id : 'card';
  const providesBindings = ensureArray(card.provides);
  const bindings = providesBindings.length > 0
    ? providesBindings
    : [{ bindTo: cardId, ref: 'card_data' }];

  const outputs: Record<string, unknown> = {};
  for (const binding of bindings) {
    const bindingObj = ensureRecord(binding);
    const bindTo = typeof bindingObj.bindTo === 'string' ? bindingObj.bindTo : '';
    const ref = typeof bindingObj.ref === 'string' ? bindingObj.ref : '';
    if (!bindTo || !ref) {
      continue;
    }
    const resolved = getAtPath(runtimeNode, ref);
    if (resolved !== undefined) {
      outputs[bindTo] = resolved;
    }
  }

  return outputs;
}

function parseSystemMessageFileIndex(messageText: unknown): number | null {
  if (typeof messageText !== 'string' || !messageText.trim()) {
    return null;
  }

  const match = /^(file uploaded|AI generated|AI geneterated):\s*.*?#(\d+)\s*$/i.exec(messageText.trim());
  if (!match) return null;

  const fileIndex = Number.parseInt(match[2], 10);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) return null;
  return fileIndex;
}

function normalizeCandidateCardPayload(card: UnknownRecord): UnknownRecord {
  return { 'card-content': card };
}

function stripMcpPrivateCardFields<T extends UnknownRecord>(card: T): T {
  const publicCard = { ...card } as UnknownRecord;
  delete publicCard.__private;
  return publicCard as T;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneRecord<T extends UnknownRecord>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyManageCardPatch(card: UnknownRecord, patch: UnknownRecord): UnknownRecord {
  const nextCard = cloneRecord(card);
  if (!patch || Object.keys(patch).length === 0) return nextCard;

  function deepSet(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
    const parts = String(dottedPath || '').split('.').filter(Boolean);
    if (!parts.length) return;
    let target = obj;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      target = target[key] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }

  if (patch.fieldValues !== undefined && patch.fieldValues !== null) {
    let writeTo: string | null = null;
    const view = ensureRecord(nextCard.view);
    const elements = ensureArray(view.elements);
    for (const rawElement of elements) {
      const data = ensureRecord(ensureRecord(rawElement).data);
      if (typeof data.writeTo === 'string' && data.writeTo) {
        writeTo = data.writeTo;
        break;
      }
    }

    if (writeTo) {
      deepSet(nextCard, writeTo, patch.fieldValues);
    } else if (typeof patch.fieldValues === 'object' && !Array.isArray(patch.fieldValues)) {
      nextCard.card_data = {
        ...ensureRecord(nextCard.card_data),
        ...(patch.fieldValues as Record<string, unknown>),
      };
    }
    return nextCard;
  }

  if (Array.isArray(patch._stagedFiles) && patch._stagedFiles.length > 0) {
    return nextCard;
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === '_stagedFiles') continue;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      nextCard[key] !== null &&
      typeof nextCard[key] === 'object' &&
      !Array.isArray(nextCard[key])
    ) {
      nextCard[key] = { ...(nextCard[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      nextCard[key] = value;
    }
  }

  return nextCard;
}

function isAdminCard(card: UnknownRecord): boolean {
  const priv = ensureRecord(card.__private);
  return priv.visible_controlplane_only === true;
}

async function readOneCard(cardStore: BoardLiveCardsMcpCardStoreDeps, cardId: string): Promise<LiveCard> {
  const result = await expectSuccessAsync(cardStore.get({ params: { id: cardId } }), 'cardStore.get');
  const cards = Array.isArray(result?.cards) ? result.cards : [];
  if (cards.length === 0) {
    throw new Error(`Card "${cardId}" not found`);
  }
  return cards[0] as LiveCard;
}

export function createBoardLiveCardsMcp(deps: BoardLiveCardsMcpDeps): BoardLiveCardsMcp {
  const {
    board,
    nonCore,
    cardStore,
    chatStore,
    processAccumulated,
    sourceFetchDone,
    sourceFetchFailed,
    uploadCardFile,
    buildFileDownloadUrl,
    readFetchedSourceJsonByRef,
  } = deps;

  function requireWebhookHandler<T>(handler: T | undefined, toolName: string): T {
    if (typeof handler === 'function') {
      return handler;
    }
    throw new Error(`${toolName} is not configured for this MCP facade`);
  }

  async function listRuntimeCards(): Promise<LiveCard[]> {
    const result = await expectSuccessAsync(cardStore.get({}), 'cardStore.get');
    // Listings (read-all) exclude control-plane-only cards; they stay reachable by id.
    return Array.isArray(result.cards)
      ? result.cards.map((card) => ensureRecord(card) as LiveCard).filter((card) => !isAdminCard(card))
      : [];
  }

  function decodeAttachmentBytes(fileEntry: UnknownRecord): Uint8Array {
    if (Array.isArray(fileEntry.bytes)) {
      return new Uint8Array(fileEntry.bytes.map((value) => Math.max(0, Math.min(255, Number(value) || 0))));
    }
    if (typeof fileEntry.text === 'string') {
      return new TextEncoder().encode(fileEntry.text);
    }
    if (typeof fileEntry.base64 === 'string') {
      const base64 = String(fileEntry.base64).replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      const binStr = atob(padded);
      return Uint8Array.from(binStr, (ch) => ch.charCodeAt(0));
    }
    throw new Error('file entry requires bytes, text, or base64');
  }

  async function discoverSourceKinds(): Promise<BoardLiveCardsMcpDiscoverSourceKindsResult> {
    const capabilityReport = ensureRecord(
      await expectSuccessAsync(nonCore.describeTaskExecutorCapabilities({}), 'describeTaskExecutorCapabilities'),
    );

    return {
      version: capabilityReport.version,
      commonSourceFields: ensureRecord(capabilityReport.commonSourceDefFields),
      sourceKinds: ensureRecord(capabilityReport.sourceKinds),
    };
  }

  async function inspectBoardRuntimeStatus(): Promise<BoardLiveCardsMcpBoardStatusResult> {
    const statusPayload = ensureRecord(await expectSuccessAsync(board.status({}), 'status'));
    const summary = ensureRecord(statusPayload.summary);
    const cards = ensureArray(statusPayload.cards);

    // Control-plane-only cards are hidden from card listings (but remain readable
    // by known id). Cross-reference the store to drop them from the listing.
    const storeForVisibility = await expectSuccessAsync(cardStore.get({}), 'cardStore.get');
    const adminCardIds = new Set(
      (Array.isArray(storeForVisibility.cards) ? storeForVisibility.cards.map(ensureRecord) : [])
        .filter(isAdminCard)
        .map((card) => (typeof card.id === 'string' ? card.id : ''))
        .filter(Boolean),
    );
    const visibleCards = cards.filter((card) => !adminCardIds.has(String(ensureRecord(card).name ?? '')));

    return {
      meta: ensureRecord(statusPayload.meta),
      summary: {
        card_count: typeof summary.card_count === 'number' ? summary.card_count : 0,
        completed: typeof summary.completed === 'number' ? summary.completed : 0,
        eligible: typeof summary.eligible === 'number' ? summary.eligible : 0,
        pending: typeof summary.pending === 'number' ? summary.pending : 0,
        blocked: typeof summary.blocked === 'number' ? summary.blocked : 0,
        in_progress: typeof summary.in_progress === 'number' ? summary.in_progress : 0,
        failed: typeof summary.failed === 'number' ? summary.failed : 0,
        unresolved: typeof summary.unresolved === 'number' ? summary.unresolved : 0,
      },
      cards: visibleCards.map((card) => {
        const cardObj = ensureRecord(card);
        return {
          'card-id': typeof cardObj.name === 'string' ? cardObj.name : null,
          status: cardObj.status ?? null,
          error: cardObj.error ?? null,
          requires: ensureArray(cardObj.requires),
          requires_satisfied: ensureArray(cardObj.requires_satisfied),
          requires_missing: ensureArray(cardObj.requires_missing),
          provides_declared: ensureArray(cardObj.provides_declared),
          provides_runtime: ensureArray(cardObj.provides_runtime),
        };
      }),
    };
  }

  async function inspectCardDefinitionAndRuntime(args: { cardId: string }): Promise<BoardLiveCardsMcpInspectCardDefinitionAndRuntimeResult> {
    const cardId = String(args.cardId || '').trim();
    if (!cardId) throw new Error('inspectCardDefinitionAndRuntime requires cardId');

    const statusPayload = ensureRecord(await expectSuccessAsync(board.status({}), 'status'));
    const cards = ensureArray(statusPayload.cards).map(ensureRecord);
    const cardStatusInBoard = cards.find((card) => card.name === cardId);
    if (!cardStatusInBoard) {
      throw new Error(`card "${cardId}" not found in board status`);
    }

    const storedCard = ensureRecord(await readOneCard(cardStore, cardId));
    // Inspecting by known id is allowed even for control-plane-only cards; only
    // listings hide them. __private is still redacted from the returned definition.
    const publicStoredCard = stripMcpPrivateCardFields(storedCard);
    const requiresKeys = ensureArray(cardStatusInBoard.requires_satisfied).filter((key): key is string => typeof key === 'string' && !!key);
    const providesKeys = ensureArray(cardStatusInBoard.provides_runtime).filter((key): key is string => typeof key === 'string' && !!key);
    const requires = Object.fromEntries(await Promise.all(
      requiresKeys.map(async (key) => [key, await expectSuccessAsync(board.getOutputsDataObject({ params: { key } }), `getOutputsDataObject(${key})`)] as const),
    ));
    const provides = Object.fromEntries(await Promise.all(
      providesKeys.map(async (key) => [key, await expectSuccessAsync(board.getOutputsDataObject({ params: { key } }), `getOutputsDataObject(${key})`)] as const),
    ));
    const computedValues = ensureRecord(
      await expectSuccessAsync(board.getOutputsComputedValues({ params: { key: cardId } }), 'getOutputsComputedValues'),
    );
    const fetchedSourceFileRefs = await expectSuccessAsync(
      board.getOutputsFetchedSources({ params: { key: cardId } }),
      'getOutputsFetchedSources',
    );

    const sourceDefs = ensureArray(storedCard.source_defs).map(ensureRecord);
    const outputFileToBindTo: Record<string, string> = {};
    for (const src of sourceDefs) {
      if (typeof src.bindTo === 'string' && typeof src.outputFile === 'string') {
        outputFileToBindTo[src.outputFile] = src.bindTo;
      }
    }

    const fetchedSources: Record<string, unknown> = {};
    for (const [outputFile, ref] of Object.entries(fetchedSourceFileRefs)) {
      const bindTo = outputFileToBindTo[outputFile] ?? outputFile;
      if (!readFetchedSourceJsonByRef || typeof ref !== 'string') {
        fetchedSources[bindTo] = null;
        continue;
      }
      try {
        fetchedSources[bindTo] = readFetchedSourceJsonByRef({ cardId, ref });
      } catch {
        fetchedSources[bindTo] = null;
      }
    }

    const runtimeNode: UnknownRecord = {
      card_data: ensureRecord(storedCard.card_data),
      requires,
      fetched_sources: fetchedSources,
      computed_values: computedValues,
    };

    return {
      cardId,
      card_status_in_board: cardStatusInBoard,
      card_definition_and_static_data: publicStoredCard,
      refs_for_fetched_source_files: fetchedSourceFileRefs,
      runtime_data: {
        requires,
        provides,
        computed_values: computedValues,
        rendered_view: materializeView(storedCard, runtimeNode),
      },
    };
  }

  async function inspectChatMessagesOnCards(args: { cardId: string; lastUserTurns?: number; tail?: number; turnId?: string; allTurns?: boolean; tailTurnsBeforeId?: string }): Promise<BoardLiveCardsMcpInspectChatMessagesResult> {
    const cardId = String(args.cardId || '').trim();
    if (!cardId) throw new Error('inspectChatMessagesOnCards requires cardId');

    const turnId = typeof args.turnId === 'string' ? args.turnId : '';
    const allTurns = args.allTurns === true;
    const tailTurnsBeforeId = typeof args.tailTurnsBeforeId === 'string' ? args.tailTurnsBeforeId : '';
    const tailTurns = allTurns ? undefined : (args.lastUserTurns ?? (turnId ? undefined : 1));
    const tail = args.tail;
    const readBody: Record<string, unknown> = {
      ...(tailTurns === undefined ? {} : { tailTurns }),
      ...(turnId ? { turnId } : {}),
      ...(allTurns ? { allTurns: true } : {}),
      ...(tailTurnsBeforeId ? { tailTurnsBeforeId } : {}),
    };
    const readInput = Object.keys(readBody).length > 0
      ? { params: { cardId }, body: readBody }
      : { params: { cardId } };
    const recordsResult = expectSuccess(await chatStore.readAll(readInput), 'chatStore.readAll');
    const card = ensureRecord(await readOneCard(cardStore, cardId));
    const attachments = ensureArray(ensureRecord(card.card_data).files)
      .map((file, idx) => ({ idx, stored_name: ensureRecord(file).stored_name }))
      .filter((entry) => typeof entry.stored_name === 'string' && entry.stored_name.length > 0);

    const turnFiltered = Array.isArray(recordsResult.records) ? recordsResult.records : [];

    const messages = turnFiltered.map((message) => {
      const messageObj = message as unknown as UnknownRecord;
      const payloadObj = ensureRecord(messageObj.payload);
      const enhanced = { ...message } as ChatRecord & { retrieval_hint?: string; payload?: UnknownRecord };
      const role = typeof message?.role === 'string'
        ? message.role
        : typeof payloadObj.role === 'string'
          ? String(payloadObj.role)
          : '';
      const messageText = typeof message?.text === 'string'
        ? message.text
        : typeof payloadObj.text === 'string'
          ? String(payloadObj.text)
          : '';
      if (role === 'system') {
        const fileIndex = parseSystemMessageFileIndex(messageText);
        const hasAttachment = fileIndex !== null && attachments.some((attachment) => attachment.idx === fileIndex);
        if (hasAttachment) {
          const retrievalHint = `Retrieve using inspect-file-contents --card-id ${cardId} --file-idx ${fileIndex}`;
          enhanced.retrieval_hint = retrievalHint;
          if (Object.keys(payloadObj).length > 0 && typeof message.role !== 'string') {
            enhanced.payload = {
              ...payloadObj,
              retrieval_hint: retrievalHint,
            };
          }
        }
      }
      return enhanced;
    });

    return {
      cardId,
      messages: typeof tail === 'number' && tail >= 0 ? messages.slice(-tail) : messages,
    };
  }

  async function inspectFileContents(args: { cardId: string; fileIdx: number }): Promise<BoardLiveCardsMcpFileDownloadDescriptor> {
    const cardId = String(args.cardId || '').trim();
    const fileIdx = Number(args.fileIdx);
    if (!cardId) throw new Error('inspectFileContents requires cardId');
    if (!Number.isInteger(fileIdx) || fileIdx < 0) throw new Error('inspectFileContents requires fileIdx to be a non-negative integer');

    const card = ensureRecord(await readOneCard(cardStore, cardId));
    const files = ensureArray(ensureRecord(card.card_data).files).map(ensureRecord);
    if (fileIdx >= files.length) {
      throw new Error(`attachment index ${fileIdx} is out of range for card "${cardId}"`);
    }

    const file = files[fileIdx];
    const storedName = typeof file.stored_name === 'string' ? file.stored_name : null;
    return {
      cardId,
      fileIdx,
      downloadUrl: buildFileDownloadUrl({ cardId, fileIdx, storedName }),
      ...(typeof file.name === 'string' ? { name: file.name } : {}),
      ...(typeof file.stored_name === 'string' ? { stored_name: file.stored_name } : {}),
      ...(typeof file.mime_type === 'string' ? { mime_type: file.mime_type } : {}),
      ...(typeof file.size === 'number' ? { size: file.size } : {}),
      ...(typeof file.uploaded_at === 'string' ? { uploaded_at: file.uploaded_at } : {}),
    };
  }

  async function preflightValidateCandidateCardDefinition(args: { candidateCardContent: UnknownRecord }): Promise<unknown> {
    return await nonCore.validateCardPreflight({ body: normalizeCandidateCardPayload(args.candidateCardContent) });
  }

  function preflightMaterializeCandidateCard(args: {
    candidateCardContent: UnknownRecord;
    mockRequires: UnknownRecord;
    mockFetchedSources: UnknownRecord;
  }): BoardLiveCardsMcpPreflightMaterializeResult | CommandResult {
    if (!args.mockRequires || typeof args.mockRequires !== 'object' || Array.isArray(args.mockRequires)) {
      throw new Error('preflightMaterializeCandidateCard requires mockRequires');
    }
    if (!args.mockFetchedSources || typeof args.mockFetchedSources !== 'object' || Array.isArray(args.mockFetchedSources)) {
      throw new Error('preflightMaterializeCandidateCard requires mockFetchedSources');
    }

    const result = nonCore.evalCardCompute({
      body: {
        'card-content': args.candidateCardContent,
        'mock-requires': args.mockRequires,
        'mock-fetched-sources': args.mockFetchedSources,
      },
    });
    if (result.status !== 'success') {
      return result;
    }

    const payload = ensureRecord(expectSuccessData(result, 'evalCardCompute'));
    const card = ensureRecord(args.candidateCardContent);
    const runtimeNode: UnknownRecord = {
      card_data: ensureRecord(card.card_data),
      requires: ensureRecord(args.mockRequires),
      fetched_sources: ensureRecord(args.mockFetchedSources),
      computed_values: ensureRecord(payload.computed_values),
    };

    return {
      status: 'success',
      data: {
        cardId: typeof payload.cardId === 'string' ? payload.cardId : (typeof card.id === 'string' ? card.id : '(unknown)'),
        ok: payload.ok === true,
        computed_values: ensureRecord(payload.computed_values),
        errors: ensureArray(payload.errors).map((entry) => {
          const record = ensureRecord(entry);
          return {
            bindTo: typeof record.bindTo === 'string' ? record.bindTo : '',
            error: typeof record.error === 'string' ? record.error : '',
          };
        }),
        provides_outputs: materializeProvidesOutputs(card, runtimeNode),
        rendered_view: materializeView(card, runtimeNode),
      },
    };
  }

  async function preflightProbeSingleSourceInCandidateCard(args: {
    candidateCardContent: UnknownRecord;
    mockProjections: UnknownRecord;
    sourceIdx: number;
  }): Promise<unknown> {
    return await nonCore.probeSourcePreflight({
      params: { sourceIdx: args.sourceIdx },
      body: {
        'card-content': args.candidateCardContent,
        'mock-projections': args.mockProjections,
      },
    });
  }

  async function preflightRunSingleSourceInCandidateCard(args: {
    candidateCardContent: UnknownRecord;
    mockProjections: UnknownRecord;
    sourceIdx: number;
  }): Promise<unknown> {
    return await nonCore.runSourcePreflight({
      params: { sourceIdx: args.sourceIdx },
      body: {
        'card-content': args.candidateCardContent,
        'mock-projections': args.mockProjections,
      },
    });
  }

  async function preflightRunSingleSourceInLiveCard(args: {
    cardId: string;
    sourceIdx: number;
    mockRequires: UnknownRecord;
  }): Promise<unknown> {
    const cardId = String(args.cardId || '').trim();
    if (!cardId) {
      throw new Error('preflightRunSingleSourceInLiveCard requires cardId');
    }
    if (!args.mockRequires || typeof args.mockRequires !== 'object' || Array.isArray(args.mockRequires)) {
      throw new Error('preflightRunSingleSourceInLiveCard requires mockRequires');
    }
    const liveCard = ensureRecord(await readOneCard(cardStore, cardId));
    const sourceDefs = ensureArray(liveCard.source_defs)
      .filter((item): item is UnknownRecord => !!item && typeof item === 'object' && !Array.isArray(item));
    let mockProjections: UnknownRecord = {};
    if (args.sourceIdx >= 0 && args.sourceIdx < sourceDefs.length) {
      const selected = sourceDefs[args.sourceIdx];
      const enriched = CardCompute.enrichSourcesSync([selected], {
        card_data: ensureRecord(liveCard.card_data),
        requires: args.mockRequires,
      });
      if (Array.isArray(enriched) && enriched.length > 0) {
        mockProjections = ensureRecord((enriched[0] as UnknownRecord)._projections);
      }
    }
    return await nonCore.runSourcePreflight({
      params: { sourceIdx: args.sourceIdx },
      body: {
        'card-content': liveCard,
        'mock-requires': args.mockRequires,
        'mock-projections': mockProjections,
      },
    });
  }

  async function preflightRunOneCycleWithCandidateCard(args: {
    candidateCardContent: UnknownRecord;
    mockRequires: UnknownRecord;
  }): Promise<BoardLiveCardsMcpPreflightRunOneCycleResult> {
    const result = ensureRecord(await expectSuccessAsync(nonCore.simulateCardCycle({
      body: {
        'card-content': args.candidateCardContent,
        'mock-requires': args.mockRequires,
      },
    }), 'simulateCardCycle'));

    const card = ensureRecord(args.candidateCardContent);
    const validation = ensureRecord(result.validation);
    const sourceProbes = ensureArray(result.source_probes);
    const projectionErrors = ensureArray(result.projection_errors);
    const fetchedSources = ensureRecord(result.fetched_sources);
    const computeErrors = ensureArray(result.compute_errors);
    const computedValues = ensureRecord(result.computed_values);
    const runtimeNode: UnknownRecord = {
      card_data: ensureRecord(card.card_data),
      requires: args.mockRequires,
      fetched_sources: fetchedSources,
      computed_values: computedValues,
    };

    const issues: string[] = [];
    for (const issue of ensureArray(validation.issues)) {
      if (typeof issue === 'string' && issue) {
        issues.push(issue);
      }
    }
    for (const probe of sourceProbes) {
      const probeObj = ensureRecord(probe);
      const bindTo = typeof probeObj.bindTo === 'string' ? probeObj.bindTo : 'source';
      const error = typeof probeObj.error === 'string' ? probeObj.error : '';
      if (error) {
        issues.push(`${bindTo}: ${error}`);
      }
    }
    for (const projectionError of projectionErrors) {
      const errObj = ensureRecord(projectionError);
      const bindTo = typeof errObj.bindTo === 'string' ? errObj.bindTo : 'source';
      const key = typeof errObj.key === 'string' ? errObj.key : 'projection';
      const error = typeof errObj.error === 'string' ? errObj.error : 'projection failed';
      issues.push(`${bindTo}.${key}: ${error}`);
    }
    for (const computeError of computeErrors) {
      const errObj = ensureRecord(computeError);
      const bindTo = typeof errObj.bindTo === 'string' ? errObj.bindTo : 'compute';
      const error = typeof errObj.error === 'string' ? errObj.error : 'compute failed';
      issues.push(`${bindTo}: ${error}`);
    }

    return {
      status: 'success',
      data: {
        cardId: typeof result.cardId === 'string' ? result.cardId : '(unknown)',
        ok: result.ok === true,
        issues,
        provides_outputs: materializeProvidesOutputs(card, runtimeNode),
        rendered_view: materializeView(card, runtimeNode),
      },
    };
  }

  async function manageReadCard(args: { cardId: string }): Promise<LiveCard[]> {
    const cardId = String(args.cardId || '').trim();
    if (!cardId) throw new Error('manageReadCard requires cardId');
    const result = await expectSuccessAsync(cardStore.get({ params: { id: cardId } }), 'cardStore.get');
    const cards = Array.isArray(result.cards) ? result.cards.map(ensureRecord) : [];
    // Reading by known id is allowed even for control-plane-only cards; __private is
    // still redacted (it is only ever exposed through /mcp-controlplane admin tools).
    return cards.map((card) => stripMcpPrivateCardFields(card) as LiveCard);
  }

  async function uploadChatAttachments(args: {
    cardId: string;
    role: string;
    turn: string;
    files?: unknown[];
  }): Promise<Array<Record<string, unknown>>> {
    const uploadedFiles = await Promise.all(ensureArray(args.files).map(async (rawFile) => {
      const fileEntry = ensureRecord(rawFile);
      const fileName = String(fileEntry.file_name ?? fileEntry.fileName ?? fileEntry.name ?? '').trim();
      const contentType = String(fileEntry.content_type ?? fileEntry.contentType ?? 'application/octet-stream');
      if (!fileName) throw new Error('file entry requires file_name');
      return await uploadCardFile({
        cardId: args.cardId,
        fileName,
        contentType,
        bytes: decodeAttachmentBytes(fileEntry),
        suppressChatRecordWrite: true,
      });
    }));

    for (const [index, uploadResult] of uploadedFiles.entries()) {
      const file = ensureRecord(uploadResult.file);
      const mergedIndex = typeof uploadResult.file_idx === 'number' && Number.isInteger(uploadResult.file_idx) && uploadResult.file_idx >= 0
        ? uploadResult.file_idx
        : index;
      const systemText = args.role === 'assistant'
        ? `AI generated: ${String(file.name || '')} as ${String(file.stored_name || '')} #${mergedIndex}`
        : `file uploaded: ${String(file.name || '')} as ${String(file.stored_name || '')} #${mergedIndex}`;
      expectSuccess(await chatStore.append({
        params: { cardId: args.cardId },
        body: { role: 'system', text: systemText, files: [], turn: args.turn },
      }), 'chatStore.append(system attachment message)');
    }

    return uploadedFiles.map((uploadResult) => uploadResult.file);
  }

  async function manageAddChatAttachment(args: {
    cardId: string;
    role?: string;
    turn?: string;
    files?: unknown[];
  }): Promise<BoardLiveCardsMcpManageAddChatAttachmentResult> {
    const cardId = String(args.cardId || '').trim();
    const role = String(args.role || 'user').trim() || 'user';
    const turn = typeof args.turn === 'string' ? args.turn : '';
    if (!cardId) throw new Error('manageAddChatAttachment requires cardId');

    const uploadedFileRecords = await uploadChatAttachments({ cardId, role, turn, files: args.files });
    return {
      status: 'success',
      data: {
        cardId,
        turn,
        files: uploadedFileRecords,
      },
    };
  }

  async function manageAddChatEntryAndAnyAttachments(args: {
    cardId: string;
    role: string;
    text?: string;
    turn?: string;
    files?: unknown[];
  }): Promise<BoardLiveCardsMcpManageAddChatEntryAndAnyAttachmentsResult> {
    const cardId = String(args.cardId || '').trim();
    const role = String(args.role || '').trim();
    const text = typeof args.text === 'string' ? args.text : '';
    const turn = typeof args.turn === 'string' ? args.turn : '';
    if (!cardId) throw new Error('manageAddChatEntryAndAnyAttachments requires cardId');
    if (!role) throw new Error('manageAddChatEntryAndAnyAttachments requires role');

    if (role === 'assistant' && turn) {
      const existingRecords = expectSuccess(await chatStore.readAll({
        params: { cardId },
        body: { turnId: turn },
      }), 'chatStore.readAll(existing turn messages)');
      const existingAssistant = Array.isArray(existingRecords.records)
        ? existingRecords.records.find((record) => record.role === 'assistant' && String(record.turn || '') === turn)
        : undefined;
      if (existingAssistant) {
        return {
          status: 'success',
          data: {
            cardId,
            id: String(existingAssistant.id),
            role,
            turn,
            files: Array.isArray(existingAssistant.files)
              ? existingAssistant.files as Array<Record<string, unknown>>
              : [],
          },
        };
      }
    }

    const uploadedFileRecords = await uploadChatAttachments({ cardId, role, turn, files: args.files });

    const appendResult = expectSuccess(await chatStore.append({
      params: { cardId },
      body: { role, text, files: uploadedFileRecords, turn },
    }), 'chatStore.append');

    return {
      status: 'success',
      data: {
        cardId,
        id: String(appendResult.id),
        role,
        turn,
        files: uploadedFileRecords,
      },
    };
  }

  async function managePatchCard(args: { cardId: string; patch: UnknownRecord }, opts: { allowControlplaneOnlyCards?: boolean } = {}): Promise<BoardLiveCardsMcpManageUpsertCardResult> {
    const cardId = String(args.cardId || '').trim();
    const patch = ensureRecord(args.patch);
    if (!cardId) throw new Error('managePatchCard requires cardId');
    // Read the current public card (manageReadCard redacts __private and allows
    // reads by known id, including control-plane-only cards).
    const cards = await manageReadCard({ cardId });
    const currentCard = ensureRecord(cards[0]);
    const patchedCard = applyManageCardPatch(currentCard, patch);
    // Delegate persistence to manageUpsertCard. The control-plane-only write block
    // is enforced there; forward the opt-out so /mcp-controlplane patches still work
    // while /mcp patches on admin cards are blocked. manageUpsertCard strips any
    // caller __private and re-applies stored __private; meta passes through.
    return manageUpsertCard({ cardId, candidateCardContent: patchedCard }, opts);
  }

  async function manageUpsertCard(args: { cardId: string; candidateCardContent: UnknownRecord }, opts: { allowControlplaneOnlyCards?: boolean } = {}): Promise<BoardLiveCardsMcpManageUpsertCardResult> {
    const cardId = String(args.cardId || '').trim();
    const incomingCandidateCard = ensureRecord(args.candidateCardContent);
    const candidateCard = stripMcpPrivateCardFields(incomingCandidateCard);
    if (!cardId) throw new Error('manageUpsertCard requires cardId');
    if (typeof candidateCard.id !== 'string' || !candidateCard.id.trim()) {
      throw new Error('candidateCardContent.id must be a non-empty string');
    }
    if (candidateCard.id !== cardId) {
      throw new Error(`candidateCardContent.id must match cardId (${cardId})`);
    }

    // Boards without a non-core (preflight) adapter — e.g. core-only runtimes —
    // cannot run schema validation. In that case skip validation and proceed with
    // the upsert rather than failing, so manage.upsert-card / manage.patch-card
    // still work on those boards.
    let validation: unknown = null;
    try {
      validation = await preflightValidateCandidateCardDefinition({ candidateCardContent: candidateCard });
    } catch (validateErr) {
      const message = validateErr instanceof Error ? validateErr.message : String(validateErr);
      if (!/non-core adapter is not configured/i.test(message)) throw validateErr;
      validation = null;
    }
    if (validation !== null) {
      const validationObj = ensureRecord(validation);
      const validationData = ensureRecord(validationObj.data);
      if (validationObj.status !== 'success' || validationData.isValid !== true) {
        return {
          status: 'fail',
          step: 'validate',
          validation,
        };
      }
    }

    let previousCard: LiveCard | null = null;
    try {
      previousCard = await readOneCard(cardStore, cardId);
    } catch {
      previousCard = null;
    }

    const previousCardRecord = previousCard ? ensureRecord(previousCard) : null;
    // All /mcp writes (upsert, patch, remove) are blocked on control-plane-only
    // cards; only /mcp-controlplane passes allowControlplaneOnlyCards to write them.
    if (previousCardRecord && isAdminCard(previousCardRecord) && !opts.allowControlplaneOnlyCards) {
      throw Object.assign(new Error(`Card "${cardId}" not found`), { statusCode: 404 });
    }
    // meta is freely caller-owned on the /mcp surface, so the caller's meta flows
    // through verbatim (no preservation/governance). Only __private is control-plane
    // state and is preserved from the stored card so the public surface can't author it.
    const cardToStore = {
      ...candidateCard,
      ...(previousCardRecord && hasOwn(previousCardRecord, '__private') ? { __private: previousCardRecord.__private } : {}),
    };

    const storeUpdate = await cardStore.set({ body: cardToStore });
    expectSuccess(storeUpdate, 'cardStore.set');

    let boardUpdate: unknown;
    try {
      boardUpdate = await board.upsertCard({ params: { cardId, restart: true } });
      expectSuccess(boardUpdate as CommandResult<unknown>, 'upsertCard');
    } catch (boardErr) {
      try {
        if (previousCard) {
          await cardStore.set({ body: previousCard });
        }
      } catch {
        // best-effort rollback
      }
      throw boardErr;
    }

    return {
      status: 'success',
      data: {
        validation,
        card_saved: null,
        board_result: boardUpdate,
      },
    };
  }

  async function manageRemoveCard(args: { cardId: string }, opts: { allowControlplaneOnlyCards?: boolean } = {}): Promise<unknown> {
    const cardId = String(args.cardId || '').trim();
    if (!cardId) throw new Error('manageRemoveCard requires cardId');
    // Removing a control-plane-only card is blocked on /mcp; only /mcp-controlplane
    // passes allowControlplaneOnlyCards to delete it.
    if (!opts.allowControlplaneOnlyCards) {
      const existing = await expectSuccessAsync(cardStore.get({ params: { id: cardId } }), 'cardStore.get');
      const existingCards = Array.isArray(existing.cards) ? existing.cards.map(ensureRecord) : [];
      if (existingCards.some(isAdminCard)) {
        throw Object.assign(new Error(`Card "${cardId}" not found`), { statusCode: 404 });
      }
    }
    const boardResult = await board.removeCard({ params: { id: cardId } });
    expectSuccess(boardResult, 'removeCard');
    const storeResult = await cardStore.del({ params: { id: cardId } });
    expectSuccess(storeResult, 'cardStore.del');
    return {
      status: 'success',
      data: {
        board_result: boardResult,
        store_result: storeResult,
      },
    };
  }

  async function adminReadCard(args: { cardId: string }): Promise<LiveCard[]> {
    const cardId = String(args.cardId || '').trim();
    if (!cardId) throw new Error('adminReadCard requires cardId');
    const result = await expectSuccessAsync(cardStore.get({ params: { id: cardId } }), 'cardStore.get');
    return Array.isArray(result.cards)
      ? result.cards.map((card) => ensureRecord(card) as LiveCard)
      : [];
  }

  async function adminUpsertCard(args: { cardId: string; candidateCardContent: UnknownRecord }): Promise<BoardLiveCardsMcpManageUpsertCardResult> {
    const cardId = String(args.cardId || '').trim();
    const incomingCandidateCard = ensureRecord(args.candidateCardContent);
    const candidateCard = stripMcpPrivateCardFields(incomingCandidateCard);
    if (!cardId) throw new Error('adminUpsertCard requires cardId');
    if (typeof candidateCard.id !== 'string' || !candidateCard.id.trim()) {
      throw new Error('candidateCardContent.id must be a non-empty string');
    }
    if (candidateCard.id !== cardId) {
      throw new Error(`candidateCardContent.id must match cardId (${cardId})`);
    }

    const validation = await preflightValidateCandidateCardDefinition({ candidateCardContent: candidateCard });
    const validationObj = ensureRecord(validation);
    const validationData = ensureRecord(validationObj.data);
    if (validationObj.status !== 'success' || validationData.isValid !== true) {
      return { status: 'fail', step: 'validate', validation };
    }

    let previousCard: LiveCard | null = null;
    try {
      previousCard = await readOneCard(cardStore, cardId);
    } catch {
      previousCard = null;
    }

    // Preserve existing __private state but always force visible_controlplane_only = true
    const existingPrivate = previousCard ? ensureRecord(ensureRecord(previousCard).__private) : {};
    const cardToStore = { ...candidateCard, __private: { ...existingPrivate, visible_controlplane_only: true } };

    const storeUpdate = await cardStore.set({ body: cardToStore });
    expectSuccess(storeUpdate, 'cardStore.set');

    let boardUpdate: unknown;
    try {
      boardUpdate = await board.upsertCard({ params: { cardId, restart: true } });
      expectSuccess(boardUpdate as CommandResult<unknown>, 'upsertCard');
    } catch (boardErr) {
      try {
        if (previousCard) await cardStore.set({ body: previousCard });
      } catch {
        // best-effort rollback
      }
      throw boardErr;
    }

    return {
      status: 'success',
      data: { validation, card_saved: null, board_result: boardUpdate },
    };
  }

  async function getChatProcessing(args: { cardId: string }): Promise<{ cardId: string; active: boolean }> {
    const cardId = String(args.cardId || '').trim();
    if (!cardId) throw new Error('getChatProcessing requires cardId');
    const data = expectSuccessData(await chatStore.isProcessing({ params: { cardId } }), 'chatStore.isProcessing');
    return { cardId, active: Boolean((data as { active?: unknown }).active) };
  }

  async function setChatProcessing(args: { cardId: string; active: boolean }): Promise<{ cardId: string; active: boolean }> {
    const cardId = String(args.cardId || '').trim();
    if (!cardId) throw new Error('setChatProcessing requires cardId');
    if (typeof args.active !== 'boolean') throw new Error('setChatProcessing requires boolean active');
    expectSuccess(await chatStore.setProcessing({ params: { cardId }, body: { active: args.active } }), 'chatStore.setProcessing');
    return { cardId, active: args.active };
  }

  async function webhookProcessAccumulated(): Promise<CommandResult<{ runtime_result: unknown }>> {
    const runtimeResult = await requireWebhookHandler(processAccumulated, 'webhook.process-accumulated')();
    if (runtimeResult?.status === 'fail' || runtimeResult?.status === 'error') {
      return runtimeResult;
    }
    return {
      status: 'success',
      data: {
        runtime_result: Object.prototype.hasOwnProperty.call(runtimeResult ?? {}, 'data')
          ? (runtimeResult as { data?: unknown }).data ?? null
          : null,
      },
    };
  }

  async function webhookSourceFetchDone(args: { token: string; ref: string }): Promise<CommandResult<{ token: string; ref: string; runtime_result: unknown }>> {
    const token = String(args.token || '').trim();
    const ref = String(args.ref || '').trim();
    if (!token) throw new Error('webhookSourceFetchDone requires token');
    if (!ref) throw new Error('webhookSourceFetchDone requires ref');
    const runtimeResult = await requireWebhookHandler(sourceFetchDone, 'webhook.source-fetch-done')({ token, ref });
    if (runtimeResult?.status === 'fail' || runtimeResult?.status === 'error') {
      return runtimeResult;
    }
    return {
      status: 'success',
      data: {
        token,
        ref,
        runtime_result: Object.prototype.hasOwnProperty.call(runtimeResult ?? {}, 'data')
          ? (runtimeResult as { data?: unknown }).data ?? null
          : null,
      },
    };
  }

  async function webhookSourceFetchFailed(args: { token: string; reason: string }): Promise<CommandResult<{ token: string; reason: string; runtime_result: unknown }>> {
    const token = String(args.token || '').trim();
    const reason = String(args.reason || '').trim();
    if (!token) throw new Error('webhookSourceFetchFailed requires token');
    if (!reason) throw new Error('webhookSourceFetchFailed requires reason');
    const runtimeResult = await requireWebhookHandler(sourceFetchFailed, 'webhook.source-fetch-failed')({ token, reason });
    if (runtimeResult?.status === 'fail' || runtimeResult?.status === 'error') {
      return runtimeResult;
    }
    return {
      status: 'success',
      data: {
        token,
        reason,
        runtime_result: Object.prototype.hasOwnProperty.call(runtimeResult ?? {}, 'data')
          ? (runtimeResult as { data?: unknown }).data ?? null
          : null,
      },
    };
  }

  return {
    listRuntimeCards,
    discoverSourceKinds,
    inspectBoardRuntimeStatus,
    inspectCardDefinitionAndRuntime,
    inspectChatMessagesOnCards,
    inspectFileContents,
    preflightValidateCandidateCardDefinition,
    preflightMaterializeCandidateCard,
    preflightProbeSingleSourceInCandidateCard,
    preflightRunSingleSourceInCandidateCard,
    preflightRunSingleSourceInLiveCard,
    preflightRunOneCycleWithCandidateCard,
    manageReadCard,
    manageAddChatAttachment,
    manageAddChatEntryAndAnyAttachments,
    managePatchCard,
    manageUpsertCard,
    manageRemoveCard,
    adminReadCard,
    adminUpsertCard,
    getChatProcessing,
    setChatProcessing,
    webhookProcessAccumulated,
    webhookSourceFetchDone,
    webhookSourceFetchFailed,
  };
}

async function expectSuccessAsync<T>(result: CommandResult<T> | Promise<CommandResult<T>>, commandName: string): Promise<T> {
  return expectSuccess(await result, commandName);
}