import { l as StepMachineStore, k as StepMachineState } from '../types-ycun84cq.cjs';

/**
 * yaml-flow - Memory Store
 *
 * In-memory store implementation. Works in both browser and Node.js.
 * Data is lost when the process exits - use for testing or short-lived flows.
 */

declare class MemoryStore implements StepMachineStore {
    private runs;
    private data;
    saveRunState(runId: string, state: StepMachineState): Promise<void>;
    loadRunState(runId: string): Promise<StepMachineState | null>;
    deleteRunState(runId: string): Promise<void>;
    setData(runId: string, key: string, value: unknown): Promise<void>;
    getData(runId: string, key: string): Promise<unknown>;
    getAllData(runId: string): Promise<Record<string, unknown>>;
    clearData(runId: string): Promise<void>;
    listRuns(): Promise<string[]>;
    /**
     * Clear all data (useful for testing)
     */
    clear(): void;
}

export { MemoryStore };
