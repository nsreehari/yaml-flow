import { CardCompute } from '../../card-compute/index.js';
import type { ComputeNode } from '../../card-compute/index.js';
import { validateCardPreflight as validateStandaloneCardPreflight } from '../../card-validation.js';
import { createAsyncBoardConfigStore } from './index.js';
import type { AsyncBoardPlatformAdapter } from './index.js';
import type { ExecutionRef } from '../common/execution-interface.js';
import type { CommandInput, CommandResult } from '../common/board-live-cards-public.js';
import type { BoardRuntimeNonCorePublic } from '../../server-runtime/types.js';

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

export interface HostedAsyncBoardNonCoreOptions {
  taskExecutorRef?: ExecutionRef;
  invokeExecutor?: (
    ref: ExecutionRef,
    subcommand: string,
    opts?: { timeout?: number; input?: string },
  ) => Promise<string>;
  unsupportedLabel?: string;
}

export function createHostedAsyncBoardNonCorePublic(
  adapter: AsyncBoardPlatformAdapter,
  options: HostedAsyncBoardNonCoreOptions = {},
): BoardRuntimeNonCorePublic {
  const configStore = () => createAsyncBoardConfigStore(adapter.kvStorage('config'));
  const unsupportedLabel = options.unsupportedLabel ?? 'hosted async runtime';

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

  async function resolveTaskExecutorRef() {
    if (options.taskExecutorRef) return options.taskExecutorRef;
    return await configStore().readTaskExecutorRef().catch(() => undefined);
  }

  async function invokeHostedNonCoreExecutor(
    subcommand: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const taskExecutorRef = await resolveTaskExecutorRef();
    if (!taskExecutorRef || !options.invokeExecutor) {
      throw new Error(`${subcommand} is not supported on the ${unsupportedLabel} yet`);
    }
    const stdout = await options.invokeExecutor(taskExecutorRef, subcommand, {
      ...(payload !== undefined ? { input: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    return asRecord(JSON.parse(trimmed));
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
        if (options.invokeExecutor && await resolveTaskExecutorRef()) {
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
          const taskExecutorRef = await resolveTaskExecutorRef();
          if (taskExecutorRef) {
            issues.push(`executor-backed source_def preflight is not supported on the ${unsupportedLabel} yet`);
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
    return fail(`${toolName} is not supported on the ${unsupportedLabel} yet`);
  }

  async function describeTaskExecutorCapabilities(): Promise<CommandResult> {
    try {
      if (options.invokeExecutor && await resolveTaskExecutorRef()) {
        return ok(await invokeHostedNonCoreExecutor('describe-capabilities', undefined, 10_000));
      }
      return await unsupported('describeTaskExecutorCapabilities');
    } catch (error) {
      return err(error);
    }
  }

  async function probeSourcePreflight(input: CommandInput): Promise<CommandResult> {
    try {
      if (!options.invokeExecutor || !await resolveTaskExecutorRef()) return await unsupported('probeSourcePreflight');
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
      if (!options.invokeExecutor || !await resolveTaskExecutorRef()) return await unsupported('runSourcePreflight') as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>;
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
        if (!options.invokeExecutor || !await resolveTaskExecutorRef()) {
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