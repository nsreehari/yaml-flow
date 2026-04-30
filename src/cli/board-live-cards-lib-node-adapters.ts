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
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lockSync } from 'proper-lockfile';
import { runDetached } from './process-runner.js';
import type {
  RuntimeInternalStore,
  RuntimeStoreSession,
  SourceRuntimeEntry,
  InferenceRuntimeEntry,
  OutputStore,
  LockingAdapter,
  InvocationAdapter,
  DispatchResult,
  ControlStore,
  TaskExecutorConfig,
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
    private readonly inferenceAdapterLogFile: string,
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

  appendInferenceLog(boardDir: string, cardId: string, payload: unknown): void {
    try {
      const entry = { timestamp: new Date().toISOString(), cardId, payload };
      fs.appendFileSync(
        path.join(boardDir, this.inferenceAdapterLogFile),
        JSON.stringify(entry) + '\n',
        'utf-8',
      );
    } catch (logErr) {
      console.error(`[inference-adapter-log] append failed: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
  }
}

export function createNodeOutputStore(
  resolveComputedValuesPath: (boardDir: string, cardId: string) => string,
  resolveDataObjectsDirPath: (boardDir: string) => string,
  inferenceAdapterLogFile: string,
): OutputStore {
  return new NodeOutputStore(resolveComputedValuesPath, resolveDataObjectsDirPath, inferenceAdapterLogFile);
}

// ============================================================================
// LockingAdapter
// ============================================================================

class NodeLockingAdapter implements LockingAdapter {
  constructor(private readonly boardFile: string) {}

  withLock<T>(boardDir: string, fn: () => T): T {
    const boardPath = path.join(boardDir, this.boardFile);
    const release = lockSync(boardPath, { retries: { retries: 5, minTimeout: 100 } });
    try {
      return fn();
    } finally {
      release();
    }
  }
}

export function createNodeLockingAdapter(boardFile: string): LockingAdapter {
  return new NodeLockingAdapter(boardFile);
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

function getCliInvocationPath(cliDir: string): { cmd: string; args: string[] } | null {
  // Prefer direct source + tsx when available (fastest startup, no dynamic import overhead).
  const tsPath = path.join(cliDir, 'board-live-cards-cli.ts');
  const localTsxBin = path.join(cliDir, '..', '..', 'node_modules', '.bin', 'tsx');
  const localTsxMjs = path.join(cliDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const localTsx = fs.existsSync(localTsxMjs) ? localTsxMjs : localTsxBin;
  if (fs.existsSync(tsPath) && fs.existsSync(localTsx)) {
    return { cmd: process.execPath, args: [localTsx, tsPath] };
  }
  // When cliDir is the project root, prefer the compiled dist entry over the wrapper.
  const distJsPath = path.join(cliDir, 'dist', 'cli', 'board-live-cards-cli.js');
  if (fs.existsSync(distJsPath)) {
    return { cmd: process.execPath, args: [distJsPath] };
  }
  // Direct JS in cliDir (e.g. dist/cli context when cliDir = dist/cli/).
  const jsPath = path.join(cliDir, 'board-live-cards-cli.js');
  if (fs.existsSync(jsPath)) {
    return { cmd: process.execPath, args: [jsPath] };
  }
  return null; // caller falls back to npx tsx
}

function buildCliInvocation(cliDir: string, command: string, args: string[]): { cmd: string; args: string[] } {
  const found = getCliInvocationPath(cliDir);
  if (found) {
    return { cmd: found.cmd, args: [...found.args, command, ...args] };
  }
  const tsPath = path.join(cliDir, 'board-live-cards-cli.ts');
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { cmd: npxCmd, args: ['tsx', tsPath, command, ...args] };
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
      const enrichedCardPath = path.join(os.tmpdir(), `card-enriched-${cardId}-${Date.now()}.json`);
      fs.writeFileSync(enrichedCardPath, JSON.stringify(enrichedCard, null, 2), 'utf-8');

      const args = ['--card', enrichedCardPath, '--token', callbackToken, '--rg', boardDir];
      const { cmd, args: cmdArgs } = buildCliInvocation(this.cliDir, 'run-sourcedefs-internal', args);
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
      const inferenceInFile = path.join(os.tmpdir(), `card-inference-${cardId}-${Date.now()}.json`);
      fs.writeFileSync(inferenceInFile, JSON.stringify(inferencePayload, null, 2), 'utf-8');

      const inferenceToken = this.encodeSourceToken({
        cbk: callbackToken, rg: boardDir, cid: cardId, b: '', d: '', cs: undefined,
      });
      const { cmd, args } = buildCliInvocation(
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
// ControlStore (read-only; written only during init/admin CLI commands)
// ============================================================================

class NodeControlStore implements ControlStore {
  constructor(
    private readonly taskExecutorFile: string,
    private readonly inferenceAdapterFile: string,
  ) {}

  readTaskExecutorConfig(boardDir: string): TaskExecutorConfig | undefined {
    const executorFile = path.join(boardDir, this.taskExecutorFile);
    if (!fs.existsSync(executorFile)) return undefined;
    const raw = fs.readFileSync(executorFile, 'utf-8').trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.command === 'string') return parsed as TaskExecutorConfig;
    } catch { /* fall through to plain-string compat */ }
    return { command: raw };
  }

  readInferenceAdapterConfig(boardDir: string): string | undefined {
    const adapterFile = path.join(boardDir, this.inferenceAdapterFile);
    if (!fs.existsSync(adapterFile)) return undefined;
    const raw = fs.readFileSync(adapterFile, 'utf-8').trim();
    return raw || undefined;
  }
}

export function createNodeControlStore(
  taskExecutorFile: string,
  inferenceAdapterFile: string,
): ControlStore {
  return new NodeControlStore(taskExecutorFile, inferenceAdapterFile);
}
