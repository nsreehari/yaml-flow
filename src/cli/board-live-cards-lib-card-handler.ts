/**
 * board-live-cards-lib — Card handler factory.
 *
 * Creates the 'card-handler' TaskHandlerFn for injection into a ReactiveGraph.
 * Uses only injected adapter interfaces — no Node built-ins are imported here.
 * This module is safe for neutral/V8 (PyMiniRacer) compilation.
 *
 * The caller (main CLI or Azure Function host) is responsible for:
 *   - Creating the BoardJournal
 *   - Calling createReactiveGraph(live, { handlers: { 'card-handler': fn } })
 *   - Acquiring the board lock before calling processAccumulatedEvents
 */

import type { TaskHandlerFn } from '../continuous-event-graph/reactive.js';
import { CardCompute } from '../card-compute/index.js';
import type { ComputeNode, ComputeStep, ComputeSource } from '../card-compute/index.js';
import type { ExecutionRequestEntry } from './board-live-cards-all-stores.js';
import type { CardRuntimeSnapshot } from './board-live-cards-all-stores.js';
import type {
  CardHandlerAdapters,
} from './board-live-cards-lib-types.js';
import {
  decideSourceAction,
  nextEntryAfterFetchDelivery,
  nextEntryAfterFetchFailure,
} from './board-live-cards-lib-types.js';

/**
 * Create the 'card-handler' TaskHandlerFn to inject into a ReactiveGraph.
 *
 * The caller owns journal and rg creation. Typical usage:
 *
 *   const handlerFn = createCardHandlerFn(adapters);
 *   const rg = createReactiveGraph(live, { handlers: { 'card-handler': handlerFn } });
 */
export function createCardHandlerFn(
  boardDir: string,
  journalId: string,
  adapters: CardHandlerAdapters,
  taskCompletedFn: (taskName: string, data: Record<string, unknown>) => void,
  _taskFailedFn: (taskName: string, error: string) => void,
): TaskHandlerFn {
  return async (input) => {
        const pendingRequests: ExecutionRequestEntry[] = [];
        const card = adapters.cardStore.readCard(input.nodeId);
        if (!card) return 'task-initiate-failure';

        const cardId = card.id as string;
        const cardState = (card.card_data ?? {}) as Record<string, unknown>;
        const allSources: ComputeSource[] = (card.source_defs ?? []) as ComputeSource[];
        const requiredSources = allSources.filter(s => s.optionalForCompletionGating !== true);

        // ---- Open runtime state via CardRuntimeStore ----
        let state: CardRuntimeSnapshot = adapters.cardRuntimeStore.readRuntime(cardId);
        let dirty = false;

        const flush = (): void => {
          if (!dirty) return;
          adapters.cardRuntimeStore.writeRuntime(cardId, state);
          dirty = false;
        };

        const getSourceEntry = (outputFile: string): import('./board-live-cards-lib-types.js').SourceRuntimeEntry =>
          ({ ...(state._sources[outputFile] ?? {}) });
        const setSourceEntry = (outputFile: string, entry: import('./board-live-cards-lib-types.js').SourceRuntimeEntry): void => {
          state._sources[outputFile] = entry; dirty = true;
        };

        // ---- If the task was restarted, clear stale source/inference state ----
        const currentExecutionCount = input.taskState?.executionCount ?? 0;
        const lastExecCount = state._lastExecutionCount;
        if (typeof lastExecCount === 'number' && lastExecCount !== currentExecutionCount) {
          state._sources = {}; dirty = true;
        }
        if (lastExecCount !== currentExecutionCount) {
          state._lastExecutionCount = currentExecutionCount; dirty = true;
        }

        // ---- Handle a task-progress re-invocation (source delivery or failure) ----
        if (input.update) {
          const u = input.update;
          const outputFile = u.outputFile as string;
          if (outputFile) {
            const entry = getSourceEntry(outputFile);
            if (u.failure) {
              setSourceEntry(outputFile, nextEntryAfterFetchFailure(entry, (u.reason as string | undefined) ?? 'unknown'));
            } else {
              const deliveryToken = typeof u.deliveryToken === 'string' ? u.deliveryToken : undefined;
              if (deliveryToken) {
                adapters.fetchedSourcesStore.commitSourceData(cardId, outputFile, deliveryToken);
              }
              setSourceEntry(outputFile, nextEntryAfterFetchDelivery(
                entry,
                (u.fetchedAt as string | undefined) ?? new Date().toISOString(),
              ));
            }
            flush();
          }
        }

        // ---- Load sourcesData from FetchedSourcesStore ----
        const sourcesData: Record<string, unknown> = {};
        for (const src of allSources) {
          if (src.outputFile) {
            const content = adapters.fetchedSourcesStore.readSourceData(cardId, src.outputFile as string);
            if (content !== null) {
              sourcesData[src.bindTo] = content;
            }
          }
        }

        // ---- Run compute ----
        // Unwrap task-completed data objects so compute expressions see the value directly.
        const requires: Record<string, unknown> = {};
        for (const [token, taskData] of Object.entries(input.state ?? {})) {
          if (taskData !== null && typeof taskData === 'object' && !Array.isArray(taskData)) {
            const unwrapped = (taskData as Record<string, unknown>)[token];
            requires[token] = unwrapped !== undefined ? unwrapped : taskData;
          } else {
            requires[token] = taskData;
          }
        }

        const computeNode: ComputeNode = {
          id: cardId,
          card_data: { ...cardState },
          requires,
          source_defs: allSources,
          compute: card.compute as ComputeStep[] | undefined,
        };
        computeNode._sourcesData = sourcesData;
        if (card.compute) {
          await CardCompute.run(computeNode, { sourcesData });
        }

        // PublishedOutputsStore is KV-backed; call sites pass values only.
        adapters.outputStore.writeComputedValues(cardId, computeNode.computed_values ?? {});

        // ---- Enrich source definitions for dispatch ----
        const enrichedCard = { ...card };
        const enrichedSources = await CardCompute.enrichSources(
          Array.isArray(card.source_defs) ? card.source_defs : undefined,
          {
            card_data: card.card_data as Record<string, unknown>,
            requires,
            sourcesData,
            computed_values: computeNode.computed_values,
          },
        );

        // Derive the card's directory from its registered path for relative cwd resolution.
        // We use a simple string operation (split on / or \) to stay Node-free.
        const registeredPath = adapters.cardStore.readCardKey(input.nodeId);
        const sourceCwd = registeredPath
          ? registeredPath.replace(/[\\/][^\\/]*$/, '')
          : boardDir;
        enrichedCard.source_defs = Array.isArray(enrichedSources)
          ? enrichedSources.map(src => ({
              ...src,
              cwd: typeof src.cwd === 'string' && src.cwd ? src.cwd : sourceCwd,
              boardDir: typeof src.boardDir === 'string' && src.boardDir ? src.boardDir : boardDir,
            }))
          : enrichedSources;

        // ---- Delivery check: are all required sources fetched for this run? ----
        const now = new Date().toISOString();
        const runQueuedAt = input.update ? undefined : now;

        const undeliveredRequired = requiredSources.filter(s => {
          const outputFile = s.outputFile;
          if (typeof outputFile !== 'string' || !outputFile) return true;
          let entry = getSourceEntry(outputFile);
          if (runQueuedAt) {
            entry = { ...entry, queueRequestedAt: runQueuedAt };
            setSourceEntry(outputFile, entry);
          }
          const qrt = entry.queueRequestedAt ?? entry.lastRequestedAt ?? now;
          const action = decideSourceAction(entry, qrt);
          if (action === 'in-flight') return false;
          return action === 'dispatch';
        });

        flush();

        if (undeliveredRequired.length > 0) {
          let stampedAny = false;
          for (const src of undeliveredRequired) {
            const outputFile = src.outputFile;
            if (typeof outputFile !== 'string' || !outputFile) continue;
            const entry = getSourceEntry(outputFile);
            setSourceEntry(outputFile, { ...entry, lastRequestedAt: now });
            stampedAny = true;
          }
          if (stampedAny) flush();
          if (!stampedAny) return 'task-initiated';

          pendingRequests.push({ taskKind: 'source-fetch', payload: { boardDir, enrichedCard: enrichedCard as Record<string, unknown>, callbackToken: input.callbackToken } });
          adapters.executionRequestStore.appendEntries(journalId, pendingRequests);
          return 'task-initiated';
        }

        // ---- All required sources delivered — build provides payload ----
        const providesBindings = (card.provides ?? []) as { bindTo: string; ref: string }[];
        const data: Record<string, unknown> = {};
        for (const { bindTo, ref } of providesBindings) {
          data[bindTo] = CardCompute.resolve(computeNode, ref);
        }

        // ---- All required sources delivered — complete the task ----
        // PublishedOutputsStore.writeDataObjects is idempotent.
        adapters.outputStore.writeDataObjects(data);

        // Spawn undelivered non-gating (optional) source_defs in background.
        const undeliveredOptional = allSources.filter(s => {
          if (s.optionalForCompletionGating !== true) return false;
          const entry = getSourceEntry(s.outputFile as string);
          if (!entry.lastRequestedAt) return true;
          if (!entry.lastFetchedAt) return true;
          return entry.lastFetchedAt <= entry.lastRequestedAt;
        });
        if (undeliveredOptional.length > 0) {
          pendingRequests.push({ taskKind: 'source-fetch', payload: { boardDir, enrichedCard: enrichedCard as Record<string, unknown>, callbackToken: input.callbackToken } });
        }

        // Notify board of task completion via injected callback.
        taskCompletedFn(input.nodeId, data);
        if (pendingRequests.length > 0) adapters.executionRequestStore.appendEntries(journalId, pendingRequests);
        return 'task-initiated';
  };
}

