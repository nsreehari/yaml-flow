/**
 * yaml-flow - LocalStorage Store
 * 
 * Browser localStorage-based store implementation.
 * Data persists across page reloads but is limited to ~5MB per origin.
 */

import type { StepMachineStore, StepMachineState } from '../step-machine/types.js';

export interface LocalStorageStoreOptions {
  /** Key prefix for namespacing (default: 'yamlflow') */
  prefix?: string;
}

export class LocalStorageStore implements StepMachineStore {
  private prefix: string;

  constructor(options: LocalStorageStoreOptions = {}) {
    this.prefix = options.prefix ?? 'yamlflow';
    
    // Ensure localStorage is available
    if (typeof localStorage === 'undefined') {
      throw new Error('LocalStorageStore requires localStorage (browser environment)');
    }
  }

  private runKey(runId: string): string {
    return `${this.prefix}:run:${runId}`;
  }

  private dataKey(runId: string): string {
    return `${this.prefix}:data:${runId}`;
  }

  private indexKey(): string {
    return `${this.prefix}:runs`;
  }

  async saveRunState(runId: string, state: StepMachineState): Promise<void> {
    localStorage.setItem(this.runKey(runId), JSON.stringify(state));
    
    // Update run index
    const runs = await this.listRuns();
    if (!runs.includes(runId)) {
      runs.push(runId);
      localStorage.setItem(this.indexKey(), JSON.stringify(runs));
    }
  }

  async loadRunState(runId: string): Promise<StepMachineState | null> {
    const raw = localStorage.getItem(this.runKey(runId));
    return raw ? JSON.parse(raw) : null;
  }

  async deleteRunState(runId: string): Promise<void> {
    localStorage.removeItem(this.runKey(runId));
    localStorage.removeItem(this.dataKey(runId));
    
    // Update run index
    const runs = await this.listRuns();
    const filtered = runs.filter(id => id !== runId);
    localStorage.setItem(this.indexKey(), JSON.stringify(filtered));
  }

  async setData(runId: string, key: string, value: unknown): Promise<void> {
    const allData = await this.getAllData(runId);
    allData[key] = value;
    localStorage.setItem(this.dataKey(runId), JSON.stringify(allData));
  }

  async getData(runId: string, key: string): Promise<unknown> {
    const allData = await this.getAllData(runId);
    return allData[key];
  }

  async getAllData(runId: string): Promise<Record<string, unknown>> {
    const raw = localStorage.getItem(this.dataKey(runId));
    return raw ? JSON.parse(raw) : {};
  }

  async clearData(runId: string): Promise<void> {
    localStorage.removeItem(this.dataKey(runId));
  }

  async listRuns(): Promise<string[]> {
    const raw = localStorage.getItem(this.indexKey());
    return raw ? JSON.parse(raw) : [];
  }

  /**
   * Clear all flow data from localStorage
   */
  clearAll(): void {
    const keysToRemove: string[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.prefix + ':')) {
        keysToRemove.push(key);
      }
    }
    
    keysToRemove.forEach(key => localStorage.removeItem(key));
  }
}
