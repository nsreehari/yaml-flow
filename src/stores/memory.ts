/**
 * yaml-flow - Memory Store
 * 
 * In-memory store implementation. Works in both browser and Node.js.
 * Data is lost when the process exits - use for testing or short-lived flows.
 */

import type { FlowStore, RunState } from '../core/types.js';

export class MemoryStore implements FlowStore {
  private runs: Map<string, RunState> = new Map();
  private data: Map<string, Record<string, unknown>> = new Map();

  async saveRunState(runId: string, state: RunState): Promise<void> {
    this.runs.set(runId, { ...state });
  }

  async loadRunState(runId: string): Promise<RunState | null> {
    const state = this.runs.get(runId);
    return state ? { ...state } : null;
  }

  async deleteRunState(runId: string): Promise<void> {
    this.runs.delete(runId);
    this.data.delete(runId);
  }

  async setData(runId: string, key: string, value: unknown): Promise<void> {
    if (!this.data.has(runId)) {
      this.data.set(runId, {});
    }
    const runData = this.data.get(runId)!;
    runData[key] = value;
  }

  async getData(runId: string, key: string): Promise<unknown> {
    return this.data.get(runId)?.[key];
  }

  async getAllData(runId: string): Promise<Record<string, unknown>> {
    return { ...(this.data.get(runId) ?? {}) };
  }

  async clearData(runId: string): Promise<void> {
    this.data.delete(runId);
  }

  async listRuns(): Promise<string[]> {
    return Array.from(this.runs.keys());
  }

  /**
   * Clear all data (useful for testing)
   */
  clear(): void {
    this.runs.clear();
    this.data.clear();
  }
}
