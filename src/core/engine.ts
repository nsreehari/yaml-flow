/**
 * yaml-flow - Core Flow Engine
 * 
 * Isomorphic workflow engine that executes declarative flows.
 * Works in both browser and Node.js environments.
 */

import type {
  FlowConfig,
  FlowStore,
  FlowResult,
  StepHandler,
  StepContext,
  StepResult,
  EngineOptions,
  RunState,
  FlowEvent,
  FlowEventListener,
  FlowEventType,
} from './types.js';
import { MemoryStore } from '../stores/memory.js';

/**
 * Generate a unique run ID
 */
function generateRunId(): string {
  // Use crypto.randomUUID if available (modern browsers + Node 19+)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * FlowEngine - The main workflow execution engine
 */
export class FlowEngine {
  private flow: FlowConfig;
  private handlers: Map<string, StepHandler>;
  private store: FlowStore;
  private components: Record<string, unknown>;
  private options: EngineOptions;
  private listeners: Map<FlowEventType, Set<FlowEventListener>> = new Map();
  private aborted: boolean = false;

  constructor(
    flow: FlowConfig,
    handlers: Record<string, StepHandler>,
    options: EngineOptions = {}
  ) {
    this.flow = flow;
    this.handlers = new Map(Object.entries(handlers));
    this.store = options.store ?? new MemoryStore();
    this.components = options.components ?? {};
    this.options = options;

    // Wire up abort signal
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        this.aborted = true;
      });
    }

    // Validate flow configuration
    this.validateFlow();
  }

  /**
   * Validate the flow configuration
   */
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

    // Check start step exists
    if (!steps[settings.start_step] && !terminal_states[settings.start_step]) {
      throw new Error(`Start step "${settings.start_step}" not found in steps or terminal_states`);
    }

    // Validate all transitions point to valid steps
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

  /**
   * Run the flow from the start
   */
  async run(initialData?: Record<string, unknown>): Promise<FlowResult> {
    const runId = generateRunId();
    const startedAt = Date.now();

    // Initialize run state
    const runState: RunState = {
      runId,
      flowId: this.flow.id ?? 'unnamed',
      currentStep: this.flow.settings.start_step,
      status: 'running',
      stepHistory: [],
      iterationCounts: {},
      retryCounts: {},
      startedAt,
      updatedAt: startedAt,
    };

    await this.store.saveRunState(runId, runState);

    // Store initial data
    if (initialData) {
      for (const [key, value] of Object.entries(initialData)) {
        await this.store.setData(runId, key, value);
      }
    }

    this.emit({
      type: 'flow:start',
      runId,
      timestamp: startedAt,
      data: { initialData },
    });

    try {
      return await this.executeLoop(runId, runState, startedAt);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      this.emit({
        type: 'flow:error',
        runId,
        timestamp: Date.now(),
        data: { error: err.message },
      });

      this.options.onError?.(err);

      // Update state to failed
      runState.status = 'failed';
      runState.updatedAt = Date.now();
      await this.store.saveRunState(runId, runState);

      return {
        runId,
        status: 'failed',
        data: await this.store.getAllData(runId),
        finalStep: runState.currentStep,
        stepHistory: runState.stepHistory,
        durationMs: Date.now() - startedAt,
        error: err,
      };
    }
  }

  /**
   * Resume a paused or interrupted flow
   */
  async resume(runId: string): Promise<FlowResult> {
    const runState = await this.store.loadRunState(runId);
    
    if (!runState) {
      throw new Error(`No run found with ID: ${runId}`);
    }

    if (runState.status === 'completed' || runState.status === 'failed') {
      throw new Error(`Cannot resume a ${runState.status} run`);
    }

    const startedAt = runState.startedAt;
    runState.status = 'running';
    runState.pausedAt = undefined;
    runState.updatedAt = Date.now();
    await this.store.saveRunState(runId, runState);

    this.emit({
      type: 'flow:resumed',
      runId,
      timestamp: Date.now(),
      data: { currentStep: runState.currentStep },
    });

    return this.executeLoop(runId, runState, startedAt);
  }

  /**
   * Pause a running flow
   */
  async pause(runId: string): Promise<void> {
    const runState = await this.store.loadRunState(runId);
    
    if (!runState) {
      throw new Error(`No run found with ID: ${runId}`);
    }

    runState.status = 'paused';
    runState.pausedAt = Date.now();
    runState.updatedAt = Date.now();
    await this.store.saveRunState(runId, runState);

    this.emit({
      type: 'flow:paused',
      runId,
      timestamp: Date.now(),
      data: { currentStep: runState.currentStep },
    });
  }

  /**
   * Main execution loop
   */
  private async executeLoop(
    runId: string,
    runState: RunState,
    startedAt: number
  ): Promise<FlowResult> {
    const maxSteps = this.flow.settings.max_total_steps ?? 100;
    const timeoutMs = this.flow.settings.timeout_ms;
    let iterations = 0;

    while (iterations < maxSteps) {
      // Check for abort
      if (this.aborted) {
        runState.status = 'cancelled';
        runState.updatedAt = Date.now();
        await this.store.saveRunState(runId, runState);

        return {
          runId,
          status: 'cancelled',
          data: await this.store.getAllData(runId),
          finalStep: runState.currentStep,
          stepHistory: runState.stepHistory,
          durationMs: Date.now() - startedAt,
        };
      }

      // Check for timeout
      if (timeoutMs && Date.now() - startedAt > timeoutMs) {
        runState.status = 'completed';
        runState.updatedAt = Date.now();
        await this.store.saveRunState(runId, runState);

        return {
          runId,
          status: 'timeout',
          intent: 'timeout',
          data: await this.store.getAllData(runId),
          finalStep: runState.currentStep,
          stepHistory: runState.stepHistory,
          durationMs: Date.now() - startedAt,
        };
      }

      const currentStep = runState.currentStep;

      // Check if we're at a terminal state
      const terminalState = this.flow.terminal_states[currentStep];
      if (terminalState) {
        runState.status = 'completed';
        runState.updatedAt = Date.now();
        await this.store.saveRunState(runId, runState);

        const allData = await this.store.getAllData(runId);
        const returnData = this.extractReturnData(terminalState.return_artifacts, allData);

        const result: FlowResult = {
          runId,
          status: 'completed',
          intent: terminalState.return_intent,
          data: returnData,
          finalStep: currentStep,
          stepHistory: runState.stepHistory,
          durationMs: Date.now() - startedAt,
        };

        this.emit({
          type: 'flow:complete',
          runId,
          timestamp: Date.now(),
          data: { ...result },
        });

        this.options.onComplete?.(result);

        return result;
      }

      // Get step configuration
      const stepConfig = this.flow.steps[currentStep];
      if (!stepConfig) {
        throw new Error(`Step "${currentStep}" not found in flow configuration`);
      }

      // Check circuit breaker
      if (stepConfig.circuit_breaker) {
        const count = runState.iterationCounts[currentStep] ?? 0;
        if (count >= stepConfig.circuit_breaker.max_iterations) {
          runState.currentStep = stepConfig.circuit_breaker.on_open;
          runState.updatedAt = Date.now();
          await this.store.saveRunState(runId, runState);
          iterations++;
          continue;
        }
      }

      // Update iteration count
      runState.iterationCounts[currentStep] = (runState.iterationCounts[currentStep] ?? 0) + 1;

      // Execute the step
      const stepResult = await this.executeStep(runId, currentStep, stepConfig);

      // Handle retry logic
      if (stepResult.result === 'failure' && stepConfig.retry) {
        const retryCount = runState.retryCounts[currentStep] ?? 0;
        if (retryCount < stepConfig.retry.max_attempts) {
          runState.retryCounts[currentStep] = retryCount + 1;
          
          // Apply delay if configured
          if (stepConfig.retry.delay_ms) {
            const delay = stepConfig.retry.backoff_multiplier
              ? stepConfig.retry.delay_ms * Math.pow(stepConfig.retry.backoff_multiplier, retryCount)
              : stepConfig.retry.delay_ms;
            await this.sleep(delay);
          }
          
          // Retry same step
          iterations++;
          continue;
        }
      }

      // Find transition
      const nextStep = stepConfig.transitions[stepResult.result];
      if (!nextStep) {
        throw new Error(
          `No transition defined for result "${stepResult.result}" in step "${currentStep}"`
        );
      }

      // Update state
      runState.stepHistory.push(currentStep);
      runState.currentStep = nextStep;
      runState.updatedAt = Date.now();
      // Reset retry count when moving to new step
      runState.retryCounts[currentStep] = 0;
      await this.store.saveRunState(runId, runState);

      this.emit({
        type: 'transition',
        runId,
        timestamp: Date.now(),
        data: { from: currentStep, to: nextStep, result: stepResult.result },
      });

      this.options.onTransition?.(currentStep, nextStep);

      iterations++;
    }

    // Max iterations reached
    runState.status = 'completed';
    runState.updatedAt = Date.now();
    await this.store.saveRunState(runId, runState);

    return {
      runId,
      status: 'max_iterations',
      intent: 'max_iterations',
      data: await this.store.getAllData(runId),
      finalStep: runState.currentStep,
      stepHistory: runState.stepHistory,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    runId: string,
    stepName: string,
    stepConfig: FlowConfig['steps'][string]
  ): Promise<StepResult> {
    // Find handler
    const handler = this.handlers.get(stepName);
    if (!handler) {
      throw new Error(`No handler registered for step "${stepName}"`);
    }

    // Build input from expected data
    const allData = await this.store.getAllData(runId);
    const input: Record<string, unknown> = {};
    
    if (stepConfig.expects_data) {
      for (const key of stepConfig.expects_data) {
        input[key] = allData[key];
      }
    } else {
      // If no expects_data, pass all data
      Object.assign(input, allData);
    }

    // Build context
    const context: StepContext = {
      runId,
      stepName,
      components: this.components,
      store: this.store,
      signal: this.options.signal,
      emit: (event: string, data: unknown) => {
        this.emit({
          type: 'step:complete' as FlowEventType, // Custom events map to step:complete
          runId,
          timestamp: Date.now(),
          data: { event, payload: data },
        });
      },
    };

    this.emit({
      type: 'step:start',
      runId,
      timestamp: Date.now(),
      data: { step: stepName, input },
    });

    try {
      // Execute handler
      const result = await handler(input, context);

      // Store produced data
      if (result.data) {
        for (const [key, value] of Object.entries(result.data)) {
          await this.store.setData(runId, key, value);
        }
      }

      this.emit({
        type: 'step:complete',
        runId,
        timestamp: Date.now(),
        data: { step: stepName, result: result.result, outputKeys: Object.keys(result.data ?? {}) },
      });

      this.options.onStep?.(stepName, result);

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      this.emit({
        type: 'step:error',
        runId,
        timestamp: Date.now(),
        data: { step: stepName, error: err.message },
      });

      // Return failure result for retry handling
      return { result: 'failure', data: { error: err.message } };
    }
  }

  /**
   * Extract data to return based on return_artifacts configuration
   */
  private extractReturnData(
    returnArtifacts: string | string[] | false | undefined,
    allData: Record<string, unknown>
  ): Record<string, unknown> {
    if (returnArtifacts === false || returnArtifacts === undefined) {
      return {};
    }

    if (typeof returnArtifacts === 'string') {
      return { [returnArtifacts]: allData[returnArtifacts] };
    }

    if (Array.isArray(returnArtifacts)) {
      const result: Record<string, unknown> = {};
      for (const key of returnArtifacts) {
        result[key] = allData[key];
      }
      return result;
    }

    return allData;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Subscribe to flow events
   */
  on(type: FlowEventType, listener: FlowEventListener): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);

    // Return unsubscribe function
    return () => {
      this.listeners.get(type)?.delete(listener);
    };
  }

  /**
   * Emit an event
   */
  private emit(event: FlowEvent): void {
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  /**
   * Get the current store instance
   */
  getStore(): FlowStore {
    return this.store;
  }
}

/**
 * Create a flow engine instance
 */
export function createEngine(
  flow: FlowConfig,
  handlers: Record<string, StepHandler>,
  options?: EngineOptions
): FlowEngine {
  return new FlowEngine(flow, handlers, options);
}
