import { G as GraphConfig, f as GraphEvent } from '../types-BBhqYGhE.cjs';
import { L as LiveGraph } from '../types-CHSdoAAA.cjs';
import { R as ReactiveGraph, a as LiveCard, s as schedule, e as TaskHandlerInput, d as ReactiveGraphOptions, L as LiveBoard } from '../live-cards-bridge-BXbVTsna.cjs';

interface BrowserSourceAdapterContext {
    card: LiveCard;
    input: TaskHandlerInput;
}
type BrowserSourceAdapter = (ctx: BrowserSourceAdapterContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
interface BoardTaskExecutorContext {
    card: LiveCard;
    input: TaskHandlerInput;
}
/**
 * Opaque task executor hook.
 * Runtime does not interpret source descriptors — executor owns that contract.
 * For source cards, return a map keyed by source.bindTo.
 */
type BoardTaskExecutor = (ctx: BoardTaskExecutorContext) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
interface BoardLiveGraphRuntimeOptions {
    /** Preferred opaque source/task executor. */
    taskExecutor?: BoardTaskExecutor;
    /** Per-card source adapters keyed by card ID. */
    sourceAdapters?: Record<string, BrowserSourceAdapter>;
    /** Default source adapter applied when no per-card adapter matches. */
    defaultSourceAdapter?: BrowserSourceAdapter;
    reactiveOptions?: Partial<Omit<ReactiveGraphOptions, 'handlers'>>;
    graphSettings?: Partial<GraphConfig['settings']>;
    executionId?: string;
}
interface LiveCardRuntimeModel {
    id: string;
    card: LiveCard;
    card_data: Record<string, unknown>;
    requires: Record<string, unknown>;
    computed_values: Record<string, unknown>;
    runtime_state: Record<string, unknown>;
}
interface BoardRuntimeView {
    id?: string;
    title?: string;
    mode?: 'board' | 'canvas';
    positions?: Record<string, {
        x?: number;
        y?: number;
        w?: number;
        h?: number;
    }>;
    settings?: Partial<GraphConfig['settings']>;
    nodes: LiveCardRuntimeModel[];
}
interface BoardLiveGraphRuntimeUpdate {
    events: GraphEvent[];
    graph: LiveGraph;
    nodes: LiveCardRuntimeModel[];
}
interface BoardLiveGraphRuntime {
    getGraph(): ReactiveGraph;
    getState(): LiveGraph;
    getNodes(): LiveCardRuntimeModel[];
    getBoard(): BoardRuntimeView;
    getSchedule(): ReturnType<typeof schedule>;
    subscribe(listener: (update: BoardLiveGraphRuntimeUpdate) => void): () => void;
    addCard(card: LiveCard): void;
    upsertCard(card: LiveCard): void;
    removeCard(cardId: string): void;
    patchCardState(cardId: string, patch: Record<string, unknown>): void;
    retrigger(cardId: string): void;
    retriggerAll(): void;
    push(event: GraphEvent): void;
    pushAll(events: GraphEvent[]): void;
    dispose(): void;
}
/**
 * LocalStorageService — browser-side persistence layer for card artifacts
 * Mirrors CLI's file-based persistence (cards, computed artifacts, status)
 *
 * Keys:
 * - 'yf:cards:<id>' → card definitions (mirrors tmp/cards/<id>.json)
 * - 'yf:runtime-out:cards:<id>' → computed artifacts (mirrors runtime-out/cards/<id>.computed.json)
 * - 'yf:runtime-out:status' → board status snapshot (mirrors runtime-out/board-livegraph-status.json)
 */
declare const LocalStorageService: {
    CARD_PREFIX: string;
    RUNTIME_OUT_PREFIX: string;
    STATUS_KEY: string;
    writeCard(cardId: string, cardObject: Record<string, unknown>): void;
    readCard(cardId: string): Record<string, unknown> | null;
    readAllCards(cardIds: string[]): Record<string, Record<string, unknown>>;
    writeComputedArtifact(artifact: Record<string, unknown>): void;
    readComputedArtifact(cardId: string): Record<string, unknown> | null;
    readAllComputedArtifacts(cardIds: string[]): Record<string, Record<string, unknown>>;
    writeStatusSnapshot(snapshot: Record<string, unknown>): void;
    readStatusSnapshot(): Record<string, unknown> | null;
    clear(): void;
};
declare function createBoardLiveGraphRuntime(input: LiveCard[] | LiveBoard, options?: BoardLiveGraphRuntimeOptions): BoardLiveGraphRuntime;
interface CardRuntimeArtifact {
    schema_version?: string;
    card_id?: string;
    card_data?: Record<string, unknown>;
    computed_values?: Record<string, unknown>;
}
interface BoardRuntimeArtifactsPayload {
    cardDefinitions: LiveCard[];
    cardRuntimeById?: Record<string, CardRuntimeArtifact>;
    dataObjectsByToken?: Record<string, unknown>;
    statusSnapshot?: {
        cards?: Array<{
            name: string;
            status?: string;
            error?: {
                message?: string;
            } | null;
            runtime?: {
                last_transition_at?: string | null;
            };
            blocked_by?: string[];
            requires_missing?: string[];
        }>;
    };
}
/**
 * Selects a single per-card render model from a runtime state payload.
 * Pure: same input → same output. Used by reactive Board to recompute
 * only the slice for one card.
 */
declare function selectLiveCardModel(payload: BoardRuntimeArtifactsPayload, cardId: string): LiveCardRuntimeModel;
/**
 * Build per-card render models for every card in the payload.
 */
declare function selectAllLiveCardModels(payload: BoardRuntimeArtifactsPayload): LiveCardRuntimeModel[];
interface BuildBrowserArtifactsOptions {
    boardPath?: string;
    cardDefinitions: LiveCard[];
    runtimeModels: LiveCardRuntimeModel[];
    graphState: LiveGraph;
}
/**
 * Converts browser-runtime state (LiveCardRuntimeModel[] + LiveGraph) back into
 * the runtime payload shape consumed by selectLiveCardModel / selectAllLiveCardModels.
 * Used by the browser-only shell to keep the same selector path as the server shell.
 */
declare function buildBrowserArtifactsFromRuntime({ boardPath, cardDefinitions, runtimeModels, graphState, }: BuildBrowserArtifactsOptions): BoardRuntimeArtifactsPayload;

export { type BoardLiveGraphRuntime, type BoardLiveGraphRuntimeOptions, type BoardLiveGraphRuntimeUpdate, type BoardRuntimeArtifactsPayload, type BoardRuntimeView, type BoardTaskExecutor, type BoardTaskExecutorContext, type BrowserSourceAdapter, type BrowserSourceAdapterContext, type BuildBrowserArtifactsOptions, type CardRuntimeArtifact, type LiveCardRuntimeModel, LocalStorageService, buildBrowserArtifactsFromRuntime, createBoardLiveGraphRuntime, selectAllLiveCardModels, selectLiveCardModel };
