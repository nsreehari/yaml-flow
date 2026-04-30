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
import type {
  CardHandlerAdapters,
  InferenceRuntimeEntry,
} from './board-live-cards-lib-types.js';
import {
  decideSourceAction,
  nextEntryAfterFetchDelivery,
  nextEntryAfterFetchFailure,
} from './board-live-cards-lib-types.js';

const DEFAULT_TASK_COMPLETION_RULE = 'all_required_sources_fetched';

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

        // ---- Open a runtime session (opaque — raw state never crosses module boundary) ----
        const session = adapters.runtimeStore.openSession(boardDir, cardId);

        // ---- If the task was restarted, clear stale source/inference state ----
        const currentExecutionCount = input.taskState?.executionCount ?? 0;
        const lastExecCount = session.getLastExecutionCount();
        if (typeof lastExecCount === 'number' && lastExecCount !== currentExecutionCount) {
          session.resetSources();
          session.resetInferenceEntry();
        }
        if (lastExecCount !== currentExecutionCount) {
          session.setLastExecutionCount(currentExecutionCount);
        }

        // ---- Handle a task-progress re-invocation (source delivery or failure) ----
        if (input.update) {
          const u = input.update;
          const outputFile = u.outputFile as string;
          // Only process source updates (which have outputFile); skip inference-done updates
          if (outputFile) {
            const entry = session.getSourceEntry(outputFile);
            if (u.failure) {
              session.setSourceEntry(outputFile, nextEntryAfterFetchFailure(entry, (u.reason as string | undefined) ?? 'unknown'));
            } else {
              session.setSourceEntry(outputFile, nextEntryAfterFetchDelivery(
                entry,
                (u.fetchedAt as string | undefined) ?? new Date().toISOString(),
              ));
            }
            session.flush();
          }
        }

        // ---- Load sourcesData from outputFiles (via CardStore — no direct fs access) ----
        const sourcesData: Record<string, unknown> = {};
        for (const src of allSources) {
          if (src.outputFile) {
            const content = adapters.cardStore.readSourceFileContent(cardId, src.outputFile);
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

        // OutputStore enforces schema_version: 'v1' internally — call sites don't set it.
        adapters.outputStore.writeComputedValues(boardDir, cardId, computeNode.computed_values ?? {});

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
          let entry = session.getSourceEntry(outputFile);
          if (runQueuedAt) {
            entry = { ...entry, queueRequestedAt: runQueuedAt };
            session.setSourceEntry(outputFile, entry);
          }
          const qrt = entry.queueRequestedAt ?? entry.lastRequestedAt ?? now;
          const action = decideSourceAction(entry, qrt);
          if (action === 'in-flight') return false;
          return action === 'dispatch';
        });

        session.flush();

        if (undeliveredRequired.length > 0) {
          let stampedAny = false;
          for (const src of undeliveredRequired) {
            const outputFile = src.outputFile;
            if (typeof outputFile !== 'string' || !outputFile) continue;
            const entry = session.getSourceEntry(outputFile);
            session.setSourceEntry(outputFile, { ...entry, lastRequestedAt: now });
            stampedAny = true;
          }
          if (stampedAny) session.flush();
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

        const completionRule = typeof card.when_is_task_completed === 'string' && card.when_is_task_completed.trim()
          ? card.when_is_task_completed.trim()
          : DEFAULT_TASK_COMPLETION_RULE;

        const cardData = card.card_data as Record<string, unknown> | undefined;
        const llmCompletion = (cardData?.llm_task_completion_inference ?? {}) as Record<string, unknown>;
        const isLlmTaskCompleted = llmCompletion.isTaskCompleted === true;

        const inferenceEntry = session.getInferenceEntry();
        const inferenceRequestedAt = typeof inferenceEntry.lastRequestedAt === 'string'
          ? inferenceEntry.lastRequestedAt
          : undefined;
        const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
          ? llmCompletion.inferenceCompletedAt
          : undefined;
        const inferencePending = !!inferenceRequestedAt
          && (!inferenceCompletedAt || inferenceCompletedAt < inferenceRequestedAt);

        const latestRequiredSourceFetchedAt = requiredSources.reduce<string | undefined>((latest, src) => {
          const fetchedAt = session.getSourceEntry(src.outputFile).lastFetchedAt;
          if (typeof fetchedAt !== 'string') return latest;
          if (!latest || fetchedAt > latest) return fetchedAt;
          return latest;
        }, undefined);

        const shouldRequestInference = !inferenceRequestedAt
          || !inferenceCompletedAt
          || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAt);

        if (completionRule !== DEFAULT_TASK_COMPLETION_RULE) {
          if (isLlmTaskCompleted) {
            // Card carries adapter-evaluated completion; fall through to deterministic completion.
          } else if (inferencePending) {
            return 'task-initiated';
          } else if (!shouldRequestInference) {
            return 'task-initiated';
          } else {
            const inferencePayload = {
              cardId,
              taskName: input.nodeId,
              completionRule,
              context: {
                requires,
                sourcesData,
                computed_values: computeNode.computed_values ?? {},
                provides: data,
                card_data: computeNode.card_data ?? {},
              },
            };

            let updatedInferenceEntry: InferenceRuntimeEntry = { ...inferenceEntry };
            if (runQueuedAt) {
              updatedInferenceEntry = { ...updatedInferenceEntry, queueRequestedAt: runQueuedAt };
              session.setInferenceEntry(updatedInferenceEntry);
            }
            const inferenceQrt = updatedInferenceEntry.queueRequestedAt ?? updatedInferenceEntry.lastRequestedAt ?? now;
            const inferenceAction = decideSourceAction(updatedInferenceEntry, inferenceQrt);

            if (inferenceAction === 'in-flight') {
              session.flush();
              return 'task-initiated';
            }
            if (inferenceAction === 'idle') {
              return 'task-initiated';
            }

            // dispatch inference
            session.setInferenceEntry({ ...updatedInferenceEntry, lastRequestedAt: now });
            session.flush();

            pendingRequests.push({ taskKind: 'inference', payload: { boardDir, cardId, inferencePayload, callbackToken: input.callbackToken } });
            adapters.executionRequestStore.appendEntries(journalId, pendingRequests);
            return 'task-initiated';
          }
        }

        // ---- All required sources delivered and no LLM inference needed ----
        // OutputStore.writeDataObjects is idempotent.
        adapters.outputStore.writeDataObjects(boardDir, data);

        // Spawn undelivered non-gating (optional) source_defs in background.
        const undeliveredOptional = allSources.filter(s => {
          if (s.optionalForCompletionGating !== true) return false;
          const entry = session.getSourceEntry(s.outputFile);
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

