import { l as StepMachineStore, k as StepMachineState } from '../types-ycun84cq.cjs';

/**
 * yaml-flow - LocalStorage Store
 *
 * Browser localStorage-based store implementation.
 * Data persists across page reloads but is limited to ~5MB per origin.
 */

interface LocalStorageStoreOptions {
    /** Key prefix for namespacing (default: 'yamlflow') */
    prefix?: string;
}
declare class LocalStorageStore implements StepMachineStore {
    private prefix;
    constructor(options?: LocalStorageStoreOptions);
    private runKey;
    private dataKey;
    private indexKey;
    saveRunState(runId: string, state: StepMachineState): Promise<void>;
    loadRunState(runId: string): Promise<StepMachineState | null>;
    deleteRunState(runId: string): Promise<void>;
    setData(runId: string, key: string, value: unknown): Promise<void>;
    getData(runId: string, key: string): Promise<unknown>;
    getAllData(runId: string): Promise<Record<string, unknown>>;
    clearData(runId: string): Promise<void>;
    listRuns(): Promise<string[]>;
    /**
     * Clear all flow data from localStorage
     */
    clearAll(): void;
}

export { LocalStorageStore, type LocalStorageStoreOptions };
