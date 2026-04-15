/**
 * yaml-flow - File Store
 * 
 * File-system based store for Node.js environments.
 * Stores each run as a JSON file in the specified directory.
 */

import type { FlowStore, RunState } from '../core/types.js';

export interface FileStoreOptions {
  /** Directory path for storing flow data */
  directory: string;
}

export class FileStore implements FlowStore {
  private directory: string;
  private fs: typeof import('fs/promises') | null = null;
  private path: typeof import('path') | null = null;

  constructor(options: FileStoreOptions) {
    this.directory = options.directory;
  }

  private async ensureModules(): Promise<void> {
    if (!this.fs || !this.path) {
      // Dynamic import for Node.js modules
      this.fs = await import('fs/promises');
      this.path = await import('path');
      
      // Ensure directory exists
      await this.fs.mkdir(this.directory, { recursive: true });
    }
  }

  private runPath(runId: string): string {
    return this.path!.join(this.directory, `${runId}.run.json`);
  }

  private dataPath(runId: string): string {
    return this.path!.join(this.directory, `${runId}.data.json`);
  }

  async saveRunState(runId: string, state: RunState): Promise<void> {
    await this.ensureModules();
    await this.fs!.writeFile(
      this.runPath(runId),
      JSON.stringify(state, null, 2),
      'utf-8'
    );
  }

  async loadRunState(runId: string): Promise<RunState | null> {
    await this.ensureModules();
    try {
      const raw = await this.fs!.readFile(this.runPath(runId), 'utf-8');
      return JSON.parse(raw);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async deleteRunState(runId: string): Promise<void> {
    await this.ensureModules();
    try {
      await this.fs!.unlink(this.runPath(runId));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      await this.fs!.unlink(this.dataPath(runId));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async setData(runId: string, key: string, value: unknown): Promise<void> {
    await this.ensureModules();
    const allData = await this.getAllData(runId);
    allData[key] = value;
    await this.fs!.writeFile(
      this.dataPath(runId),
      JSON.stringify(allData, null, 2),
      'utf-8'
    );
  }

  async getData(runId: string, key: string): Promise<unknown> {
    const allData = await this.getAllData(runId);
    return allData[key];
  }

  async getAllData(runId: string): Promise<Record<string, unknown>> {
    await this.ensureModules();
    try {
      const raw = await this.fs!.readFile(this.dataPath(runId), 'utf-8');
      return JSON.parse(raw);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw err;
    }
  }

  async clearData(runId: string): Promise<void> {
    await this.ensureModules();
    try {
      await this.fs!.unlink(this.dataPath(runId));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async listRuns(): Promise<string[]> {
    await this.ensureModules();
    try {
      const files = await this.fs!.readdir(this.directory);
      return files
        .filter(f => f.endsWith('.run.json'))
        .map(f => f.replace('.run.json', ''));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Clear all flow data from directory
   */
  async clearAll(): Promise<void> {
    await this.ensureModules();
    const runs = await this.listRuns();
    await Promise.all(runs.map(runId => this.deleteRunState(runId)));
  }
}
