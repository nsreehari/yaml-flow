/**
 * Step Machine — Convenience Driver Class
 *
 * Wraps the pure reducer with a run loop and store I/O.
 * This is the framework layer. The reducer is the pure core.
 */

import type {
  StepFlowConfig,
  StepMachineStore,
  StepMachineResult,
  StepHandler,
  StepContext,
  StepResult,
  StepMachineState,
  StepMachineOptions,
  StepEvent,
  StepEventType,
  StepEventListener,
} from './types.js';
import {
  applyStepResult,
  checkCircuitBreaker,
  computeStepInput,
  extractReturnData,
  createInitialState,
} from './reducer.js';
import { MemoryStore } from '../stores/memory.js';

function generateRunId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class StepMachine {
  private flow: StepFlowConfig;
  private handlers: Map<string, StepHandler>;
  private store: StepMachineStore;
  private components: Record<string, unknown>;
  private options: StepMachineOptions;
  private listeners: Map<StepEventType, Set<StepEventListener>> = new Map();
  private aborted = false;

  constructor(
    flow: StepFlowConfig,
    handlers: Record<string, StepHandler>,
    options: StepMachineOptions = {}
  ) {
    this.flow = flow;
    this.handlers = new Map(Object.entries(handlers));
    this.store = options.store ?? new MemoryStore();
    this.components = options.components ?? {};
    this.options = options;

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        this.aborted = true;
      });
    }

    this.validateFlow();
  }

  private validateFlow(): void {
    const { settings, steps, terminal_states } = this.flow;

    if (!settings?.start_step) {
      throw new Error('Flow must have settings.start_step defined');
    }
    if (!steps || Object.keys(steps).length === 0) {
      throw new Error('Flow must have at least one step defined');
    }
    if (!terminal_states || Object.keys(terminal_states).length === 0) {
      throw new Error('Flow must have at least one terminal_state defined');
    }
    if (!steps[settings.start_step] && !terminal_states[settings.start_step]) {
      throw new Error(`Start step "${settings.start_step}" not found`);
    }
    for (const [stepName, stepConfig] of Object.entries(steps)) {
      for (const [result, target] of Object.entries(stepConfig.transitions)) {
        if (!steps[target] && !terminal_states[target]) {
          throw new Error(
            `Step "${stepName}" transition "${result}" points to unknown step "${target}"`
          );
        }
      }
    }
  }

  on(eventType: StepEventType, listener: StepEventListener): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
  }

  off(eventType: StepEventType, listener: StepEventListener): void {
    this.listeners.get(eventType)?.delete(listener);
  }

  private emit(event: StepEvent): void {
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try { listener(event); } catch { /* swallow listener errors */ }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async run(initialData?: Record<string, unknown>): Promise<StepMachineResult> {
    const runId = generateRunId();
    let runState = createInitialState(this.flow, runId);

    await this.store.saveRunState(runId, runState);

    if (initialData) {
      for (const [key, value] of Object.entries(initialData)) {
        await this.store.setData(runId, key, value);
      }
    }

    this.emit({
      type: 'flow:start',
      runId,
      timestamp: runState.startedAt,
      data: { initialData: initialData ?? {} },
    });

    try {
      return await this.executeLoop(runId, runState);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit({ type: 'flow:error', runId, timestamp: Date.now(), data: { error: err.message } });
      this.options.onError?.(err);

      runState = { ...runState, status: 'failed', updatedAt: Date.now() };
      await this.store.saveRunState(runId, runState);

      return {
        runId,
        status: 'failed',
        data: await this.store.getAllData(runId),
        finalStep: runState.currentStep,
        stepHistory: runState.stepHistory,
        durationMs: Date.now() - runState.startedAt,
        error: err,
      };
    }
  }

  async resume(runId: string): Promise<StepMachineResult> {
    const runState = await this.store.loadRunState(runId);
    if (!runState) throw new Error(`No run found with ID: ${runId}`);
    if (runState.status === 'completed' || runState.status === 'failed') {
      throw new Error(`Cannot resume a ${runState.status} run`);
    }

    const updated: StepMachineState = { ...runState, status: 'running', pausedAt: undefined, updatedAt: Date.now() };
    await this.store.saveRunState(runId, updated);
    this.emit({ type: 'flow:resumed', runId, timestamp: Date.now(), data: { currentStep: updated.currentStep } });

    return this.executeLoop(runId, updated);
  }

  async pause(runId: string): Promise<void> {
    const runState = await this.store.loadRunState(runId);
    if (!runState) throw new Error(`No run found with ID: ${runId}`);

    const updated: StepMachineState = { ...runState, status: 'paused', pausedAt: Date.now(), updatedAt: Date.now() };
    await this.store.saveRunState(runId, updated);
    this.emit({ type: 'flow:paused', runId, timestamp: Date.now(), data: { currentStep: updated.currentStep } });
  }

  private async executeLoop(runId: string, runState: StepMachineState): Promise<StepMachineResult> {
    const maxSteps = this.flow.settings.max_total_steps ?? 100;
    const timeoutMs = this.flow.settings.timeout_ms;
    let current = runState;
    let iterations = 0;

    while (iterations < maxSteps) {
      if (this.aborted) {
        current = { ...current, status: 'cancelled', updatedAt: Date.now() };
        await this.store.saveRunState(runId, current);
        return { runId, status: 'cancelled', data: await this.store.getAllData(runId), finalStep: current.currentStep, stepHistory: current.stepHistory, durationMs: Date.now() - current.startedAt };
      }

      if (timeoutMs && Date.now() - current.startedAt > timeoutMs) {
        current = { ...current, status: 'completed', updatedAt: Date.now() };
        await this.store.saveRunState(runId, current);
        return { runId, status: 'timeout', intent: 'timeout', data: await this.store.getAllData(runId), finalStep: current.currentStep, stepHistory: current.stepHistory, durationMs: Date.now() - current.startedAt };
      }

      const stepName = current.currentStep;

      // Terminal state check
      const terminalState = this.flow.terminal_states[stepName];
      if (terminalState) {
        current = { ...current, status: 'completed', updatedAt: Date.now() };
        await this.store.saveRunState(runId, current);
        const allData = await this.store.getAllData(runId);
        const result: StepMachineResult = {
          runId, status: 'completed', intent: terminalState.return_intent,
          data: extractReturnData(terminalState.return_artifacts, allData),
          finalStep: stepName, stepHistory: current.stepHistory, durationMs: Date.now() - current.startedAt,
        };
        this.emit({ type: 'flow:complete', runId, timestamp: Date.now(), data: { ...result } });
        this.options.onComplete?.(result);
        return result;
      }

      // Circuit breaker (pure)
      const cbResult = checkCircuitBreaker(this.flow, current, stepName);
      if (cbResult.broken) {
        current = cbResult.newState;
        await this.store.saveRunState(runId, current);
        iterations++;
        continue;
      }
      current = cbResult.newState;

      // Execute step handler (impure — localized)
      const allData = await this.store.getAllData(runId);
      const input = computeStepInput(this.flow, stepName, allData);
      const context: StepContext = {
        runId, stepName, components: this.components, store: this.store,
        signal: this.options.signal,
        emit: (event: string, data: unknown) => {
          this.emit({ type: 'step:complete' as StepEventType, runId, timestamp: Date.now(), data: { event, payload: data } });
        },
      };

      this.emit({ type: 'step:start', runId, timestamp: Date.now(), data: { step: stepName, input } });

      let stepResult: StepResult;
      try {
        const handler = this.handlers.get(stepName);
        if (!handler) throw new Error(`No handler registered for step "${stepName}"`);
        stepResult = await handler(input, context);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit({ type: 'step:error', runId, timestamp: Date.now(), data: { step: stepName, error: err.message } });
        stepResult = { result: 'failure', data: { error: err.message } };
      }

      // Store produced data
      if (stepResult.data) {
        for (const [key, value] of Object.entries(stepResult.data)) {
          await this.store.setData(runId, key, value);
        }
      }

      this.emit({ type: 'step:complete', runId, timestamp: Date.now(), data: { step: stepName, result: stepResult.result } });
      this.options.onStep?.(stepName, stepResult);

      // Apply step result (pure reducer)
      const reducerResult = applyStepResult(this.flow, current, stepName, stepResult);
      current = reducerResult.newState;

      if (reducerResult.shouldRetry) {
        await this.store.saveRunState(runId, current);
        const stepConfig = this.flow.steps[stepName];
        if (stepConfig.retry?.delay_ms) {
          const retryCount = current.retryCounts[stepName] ?? 0;
          const delay = stepConfig.retry.backoff_multiplier
            ? stepConfig.retry.delay_ms * Math.pow(stepConfig.retry.backoff_multiplier, retryCount - 1)
            : stepConfig.retry.delay_ms;
          await this.sleep(delay);
        }
        iterations++;
        continue;
      }

      await this.store.saveRunState(runId, current);
      this.emit({ type: 'transition', runId, timestamp: Date.now(), data: { from: stepName, to: current.currentStep, result: stepResult.result } });
      this.options.onTransition?.(stepName, current.currentStep);
      iterations++;
    }

    // Max iterations
    current = { ...current, status: 'completed', updatedAt: Date.now() };
    await this.store.saveRunState(runId, current);
    return { runId, status: 'max_iterations', intent: 'max_iterations', data: await this.store.getAllData(runId), finalStep: current.currentStep, stepHistory: current.stepHistory, durationMs: Date.now() - current.startedAt };
  }
}

/** Convenience factory */
export function createStepMachine(
  flow: StepFlowConfig,
  handlers: Record<string, StepHandler>,
  options?: StepMachineOptions
): StepMachine {
  return new StepMachine(flow, handlers, options);
}
