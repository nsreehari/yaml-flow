/**
 * yaml-flow - KVStorageStore
 *
 * StepMachineStore backed by a platform-agnostic KVStorage.
 * The platform adapter provides the right KVStorage implementation
 * (Node.js FS, browser localStorage, in-memory, CosmosDB, etc.).
 *
 * Key schema (all parts are base64url-encoded — alphanumeric + '-' + '_' only):
 *   state_<b64(runId)>              → StepMachineState
 *   data_<b64(runId)>_<b64(key)>   → arbitrary value
 */

import type { StepMachineStore, StepMachineState } from '../step-machine/types.js';
import type { KVStorage } from '../cli/common/storage-interface.js';

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromb64url(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

export class KVStorageStore implements StepMachineStore {
  constructor(private readonly kv: KVStorage) {}

  private stateKey(runId: string): string { return `state_${b64url(runId)}`; }
  private dataPrefix(runId: string): string { return `data_${b64url(runId)}_`; }
  private dataKey(runId: string, key: string): string { return `${this.dataPrefix(runId)}${b64url(key)}`; }

  async saveRunState(runId: string, state: StepMachineState): Promise<void> {
    this.kv.write(this.stateKey(runId), state);
  }

  async loadRunState(runId: string): Promise<StepMachineState | null> {
    const v = this.kv.read(this.stateKey(runId));
    return v != null && typeof v === 'object' ? (v as StepMachineState) : null;
  }

  async deleteRunState(runId: string): Promise<void> {
    this.kv.delete(this.stateKey(runId));
    for (const k of this.kv.listKeys(this.dataPrefix(runId))) this.kv.delete(k);
  }

  async setData(runId: string, key: string, value: unknown): Promise<void> {
    this.kv.write(this.dataKey(runId, key), value);
  }

  async getData(runId: string, key: string): Promise<unknown> {
    return this.kv.read(this.dataKey(runId, key));
  }

  async getAllData(runId: string): Promise<Record<string, unknown>> {
    const prefix = this.dataPrefix(runId);
    const result: Record<string, unknown> = {};
    for (const k of this.kv.listKeys(prefix)) {
      result[fromb64url(k.slice(prefix.length))] = this.kv.read(k);
    }
    return result;
  }

  async clearData(runId: string): Promise<void> {
    for (const k of this.kv.listKeys(this.dataPrefix(runId))) this.kv.delete(k);
  }

  async listRuns(): Promise<string[]> {
    return this.kv.listKeys('state_').map(k => fromb64url(k.slice('state_'.length)));
  }
}
