/**
 * Step Machine Types
 *
 * All type definitions for the step-machine workflow engine.
 * The step machine is a stateful sequential executor:
 *   currentState + stepResult → newState (via transitions)
 */
interface StepFlowConfig {
    id?: string;
    settings: StepFlowSettings;
    steps: Record<string, StepConfig>;
    terminal_states: Record<string, TerminalStateConfig>;
}
interface StepFlowSettings {
    start_step: string;
    max_total_steps?: number;
    timeout_ms?: number;
}
interface StepConfig {
    description?: string;
    expects_data?: string[];
    produces_data?: string[];
    transitions: Record<string, string>;
    failure_transitions?: Record<string, string>;
    retry?: RetryConfig;
    circuit_breaker?: CircuitBreakerConfig;
}
interface RetryConfig {
    max_attempts: number;
    delay_ms?: number;
    backoff_multiplier?: number;
}
interface CircuitBreakerConfig {
    max_iterations: number;
    on_open: string;
}
interface TerminalStateConfig {
    description?: string;
    return_intent: string;
    return_artifacts?: string | string[] | false;
    expects_data?: string[];
}
type StepHandler = (input: StepInput, context: StepContext) => StepResult | Promise<StepResult>;
interface StepInput {
    [key: string]: unknown;
}
interface StepContext {
    runId: string;
    stepName: string;
    components: Record<string, unknown>;
    store: StepMachineStore;
    signal?: AbortSignal;
    emit: (event: string, data: unknown) => void;
}
interface StepResult {
    result: string;
    data?: Record<string, unknown>;
}
interface StepMachineState {
    runId: string;
    flowId: string;
    currentStep: string;
    status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    stepHistory: string[];
    iterationCounts: Record<string, number>;
    retryCounts: Record<string, number>;
    startedAt: number;
    updatedAt: number;
    pausedAt?: number;
}
interface StepReducerResult {
    newState: StepMachineState;
    nextStep: string;
    isTerminal: boolean;
    isCircuitBroken: boolean;
    shouldRetry: boolean;
}
interface StepMachineOptions {
    store?: StepMachineStore;
    components?: Record<string, unknown>;
    signal?: AbortSignal;
    onStep?: (stepName: string, result: StepResult) => void;
    onTransition?: (from: string, to: string) => void;
    onComplete?: (result: StepMachineResult) => void;
    onError?: (error: Error) => void;
}
interface StepMachineResult {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'max_iterations';
    intent?: string;
    data: Record<string, unknown>;
    finalStep: string;
    stepHistory: string[];
    durationMs: number;
    error?: Error;
}
interface StepMachineStore {
    saveRunState(runId: string, state: StepMachineState): Promise<void>;
    loadRunState(runId: string): Promise<StepMachineState | null>;
    deleteRunState(runId: string): Promise<void>;
    setData(runId: string, key: string, value: unknown): Promise<void>;
    getData(runId: string, key: string): Promise<unknown>;
    getAllData(runId: string): Promise<Record<string, unknown>>;
    clearData(runId: string): Promise<void>;
    listRuns?(): Promise<string[]>;
}
type StepEventType = 'flow:start' | 'flow:complete' | 'flow:error' | 'flow:paused' | 'flow:resumed' | 'step:start' | 'step:complete' | 'step:error' | 'transition';
interface StepEvent {
    type: StepEventType;
    runId: string;
    timestamp: number;
    data: Record<string, unknown>;
}
type StepEventListener = (event: StepEvent) => void;

export type { CircuitBreakerConfig as C, RetryConfig as R, StepConfig as S, TerminalStateConfig as T, StepContext as a, StepEvent as b, StepEventListener as c, StepEventType as d, StepFlowConfig as e, StepFlowSettings as f, StepHandler as g, StepInput as h, StepMachineOptions as i, StepMachineResult as j, StepMachineState as k, StepMachineStore as l, StepReducerResult as m, StepResult as n };
