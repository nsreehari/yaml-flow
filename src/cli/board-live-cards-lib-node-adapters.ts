/**
 * board-live-cards-lib — Node.js filesystem adapter implementations.
 *
 * This file contains all Node built-in usage for the lib adapters.
 * It is the ONLY place where fs, path, os, child_process, and proper-lockfile
 * are used on behalf of the lib. CLI and test code should use these factories
 * to obtain adapter instances.
 *
 * Invariant enforcement:
 *   - RuntimeInternalStore: raw CardRuntimeState stays private; exposed only via session.
 *   - OutputStore: schema_version: 'v1' is set here, never at call sites.
 *   - LockingAdapter: callers acquire the lock at the service boundary.
 *   - InvocationAdapter: returns DispatchResult, manages its own temp files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDetached, makeBoardTempFilePath, buildBoardCliInvocation } from './process-runner.js';
import type {
  RuntimeInternalStore,
  RuntimeStoreSession,
  SourceRuntimeEntry,
  InferenceRuntimeEntry,
  OutputStore,
  InvocationAdapter,
  DispatchResult,
} from './board-live-cards-lib-types.js';

// ============================================================================
// Internal raw type — never exported
// ============================================================================

interface CardRuntimeState {
  _sources: Record<string, SourceRuntimeEntry>;
  _inferenceEntry?: InferenceRuntimeEntry;
  _lastExecutionCount?: number;
}

// ============================================================================
// RuntimeInternalStore
// ============================================================================

class NodeRuntimeStoreSession implements RuntimeStoreSession {
  private state: CardRuntimeState;
  private dirty = false;

  constructor(
    private readonly boardDir: string,
    private readonly cardId: string,
  ) {
    this.state = NodeRuntimeInternalStore.readState(boardDir, cardId);
  }

  getSourceEntry(outputFile: string): SourceRuntimeEntry {
    return { ...(this.state._sources[outputFile] ?? {}) };
  }

  setSourceEntry(outputFile: string, entry: SourceRuntimeEntry): void {
    this.state._sources[outputFile] = entry;
    this.dirty = true;
  }

  resetSources(): void {
    this.state._sources = {};
    this.dirty = true;
  }

  getInferenceEntry(): InferenceRuntimeEntry {
    return { ...(this.state._inferenceEntry ?? {}) };
  }

  setInferenceEntry(entry: InferenceRuntimeEntry): void {
    this.state._inferenceEntry = entry;
    this.dirty = true;
  }

  resetInferenceEntry(): void {
    this.state._inferenceEntry = undefined;
    this.dirty = true;
  }

  getLastExecutionCount(): number | undefined {
    return this.state._lastExecutionCount;
  }

  setLastExecutionCount(count: number): void {
    this.state._lastExecutionCount = count;
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    NodeRuntimeInternalStore.writeState(this.boardDir, this.cardId, this.state);
    this.dirty = false;
  }
}

class NodeRuntimeInternalStore implements RuntimeInternalStore {
  openSession(boardDir: string, cardId: string): RuntimeStoreSession {
    return new NodeRuntimeStoreSession(boardDir, cardId);
  }

  static readState(boardDir: string, cardId: string): CardRuntimeState {
    const p = path.join(boardDir, cardId, 'runtime.json');
    if (!fs.existsSync(p)) return { _sources: {} };
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as CardRuntimeState; }
    catch { return { _sources: {} }; }
  }

  static writeState(boardDir: string, cardId: string, state: CardRuntimeState): void {
    const p = path.join(boardDir, cardId, 'runtime.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  }
}

export function createNodeRuntimeStore(): RuntimeInternalStore {
  return new NodeRuntimeInternalStore();
}

// ============================================================================
// OutputStore
// ============================================================================

function writeJsonAtomic(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

class NodeOutputStore implements OutputStore {
  constructor(
    private readonly resolveComputedValuesPath: (boardDir: string, cardId: string) => string,
    private readonly resolveDataObjectsDirPath: (boardDir: string) => string,
  ) {}

  writeComputedValues(boardDir: string, cardId: string, values: Record<string, unknown>): void {
    // schema_version enforced here — call sites never set it.
    writeJsonAtomic(this.resolveComputedValuesPath(boardDir, cardId), {
      schema_version: 'v1',
      card_id: cardId,
      computed_values: values,
    });
  }

  writeDataObjects(boardDir: string, data: Record<string, unknown>): void {
    for (const [token, payload] of Object.entries(data)) {
      if (!token) continue;
      // Sanitize token to prevent path traversal.
      const fileName = token.replace(/[\\/]/g, '__');
      if (!fileName) continue;
      writeJsonAtomic(path.join(this.resolveDataObjectsDirPath(boardDir), fileName), payload);
    }
  }

}

export function createNodeOutputStore(
  resolveComputedValuesPath: (boardDir: string, cardId: string) => string,
  resolveDataObjectsDirPath: (boardDir: string) => string,
): OutputStore {
  return new NodeOutputStore(resolveComputedValuesPath, resolveDataObjectsDirPath);
}

// ============================================================================
// InvocationAdapter
//
// The adapter owns temp file creation — the lib core never touches os.tmpdir().
// Returns DispatchResult instead of using error-first callbacks.
//
// BOARD_LIVE_CARDS_NO_SPAWN=1 suppresses actual spawning (used in tests).
// ============================================================================

function shouldSuppressSpawn(): boolean {
  return process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1';
}

class NodeInvocationAdapter implements InvocationAdapter {
  constructor(
    private readonly cliDir: string,
    private readonly encodeSourceToken: (payload: {
      cbk: string; rg: string; cid: string; b: string; d: string; cs?: string;
    }) => string,
  ) {}

  async requestSourceFetch(
    boardDir: string,
    enrichedCard: Record<string, unknown>,
    callbackToken: string,
  ): Promise<DispatchResult> {
    if (shouldSuppressSpawn()) {
      return { dispatched: false, invocationId: undefined };
    }
    try {
      // Write enriched card to a temp file — the adapter owns this concern.
      const cardId = (enrichedCard.id as string | undefined) ?? 'unknown';
      const enrichedCardPath = makeBoardTempFilePath(boardDir, `card-enriched-${cardId}`);
      fs.writeFileSync(enrichedCardPath, JSON.stringify(enrichedCard, null, 2), 'utf-8');

      const args = ['--card', enrichedCardPath, '--token', callbackToken, '--rg', boardDir];
      const { cmd, args: cmdArgs } = buildBoardCliInvocation(this.cliDir, 'run-sourcedefs-internal', args);
      const invocationId = randomUUID();
      runDetached({ command: cmd, args: cmdArgs });
      return { dispatched: true, invocationId };
    } catch (err) {
      return { dispatched: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async requestInference(
    boardDir: string,
    cardId: string,
    inferencePayload: unknown,
    callbackToken: string,
  ): Promise<DispatchResult> {
    if (shouldSuppressSpawn()) {
      return { dispatched: false, invocationId: undefined };
    }
    try {
      // Write inference input to a temp file — the adapter owns this concern.
      const inferenceInFile = makeBoardTempFilePath(boardDir, `card-inference-${cardId}`);
      fs.writeFileSync(inferenceInFile, JSON.stringify(inferencePayload, null, 2), 'utf-8');

      const inferenceToken = this.encodeSourceToken({
        cbk: callbackToken, rg: boardDir, cid: cardId, b: '', d: '', cs: undefined,
      });
      const { cmd, args } = buildBoardCliInvocation(
        this.cliDir,
        'run-inference-internal',
        ['--in', inferenceInFile, '--token', inferenceToken],
      );
      const invocationId = randomUUID();
      runDetached({ command: cmd, args });
      return { dispatched: true, invocationId };
    } catch (err) {
      return { dispatched: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createNodeInvocationAdapter(
  cliDir: string,
  encodeSourceToken: (payload: {
    cbk: string; rg: string; cid: string; b: string; d: string; cs?: string;
  }) => string,
): InvocationAdapter {
  return new NodeInvocationAdapter(cliDir, encodeSourceToken);
}

// ============================================================================
// ControlStore is replaced by BoardConfigStore (all-stores.ts).
// createNodeControlStore is removed — kept here as a tombstone comment only.
// ============================================================================
