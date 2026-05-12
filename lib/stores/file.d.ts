import { l as StepMachineStore, k as StepMachineState } from '../types-ycun84cq.js';

/**
 * yaml-flow - File Store
 *
 * File-system based store for Node.js environments.
 * Stores each run as a JSON file in the specified directory.
 */

interface FileStoreOptions {
    /** Directory path for storing flow data */
    directory: string;
}
declare class FileStore implements StepMachineStore {
    private directory;
    private fs;
    private path;
    constructor(options: FileStoreOptions);
    private ensureModules;
    private runPath;
    private dataPath;
    saveRunState(runId: string, state: StepMachineState): Promise<void>;
    loadRunState(runId: string): Promise<StepMachineState | null>;
    deleteRunState(runId: string): Promise<void>;
    setData(runId: string, key: string, value: unknown): Promise<void>;
    getData(runId: string, key: string): Promise<unknown>;
    getAllData(runId: string): Promise<Record<string, unknown>>;
    clearData(runId: string): Promise<void>;
    listRuns(): Promise<string[]>;
    /**
     * Clear all flow data from directory
     */
    clearAll(): Promise<void>;
}

export { FileStore, type FileStoreOptions };
