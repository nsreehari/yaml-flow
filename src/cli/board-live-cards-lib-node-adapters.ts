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
import { spawn } from 'node:child_process';
import { lockSync } from 'proper-lockfile';
import type {
  RuntimeInternalStore,
  RuntimeStoreSession,
  SourceRuntimeEntry,
  InferenceRuntimeEntry,
  OutputStore,
  InputStore,
  LockingAdapter,
  InvocationAdapter,
  DispatchResult,
  CardStore,
  ControlStore,
  TaskExecutorConfig,
} from './board-live-cards-lib-types.js';
import type { GraphEvent } from '../event-graph/types.js';

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
// InputStore
// ============================================================================

class NodeInputStore implements InputStore {
  constructor(private readonly journalFile: string) {}

  appendEvent(boardDir: string, event: GraphEvent): void {
    const journalPath = path.join(boardDir, this.journalFile);
    const entry = { id: randomUUID(), event };
    fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n', 'utf-8');
  }
}

export function createNodeInputStore(journalFile: string): InputStore {
  return new NodeInputStore(journalFile);
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
  const jsPath = path.join(cliDir, 'board-live-cards-cli.js');
  if (fs.existsSync(jsPath)) {
    return { cmd: process.execPath, args: [jsPath] };
  }
  const tsPath = path.join(cliDir, 'board-live-cards-cli.ts');
  const localTsx = path.join(cliDir, '..', '..', 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(tsPath) && fs.existsSync(localTsx)) {
    return { cmd: process.execPath, args: [localTsx, tsPath] };
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

let _gitBashCache: string | false | undefined;
const GIT_BASH_CACHE_FILE = path.join(os.tmpdir(), '.board-live-cards-git-bash-path.json');

function findGitBash(): string | false {
  if (_gitBashCache !== undefined) return _gitBashCache;
  try {
    const cached = JSON.parse(fs.readFileSync(GIT_BASH_CACHE_FILE, 'utf-8'));
    if (typeof cached?.path === 'string' || cached?.path === false) {
      _gitBashCache = cached.path;
      return _gitBashCache as string | false;
    }
  } catch { /* miss */ }
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      _gitBashCache = c;
      try { fs.writeFileSync(GIT_BASH_CACHE_FILE, JSON.stringify({ path: c })); } catch { /* best-effort */ }
      return c;
    }
  }
  _gitBashCache = false;
  try { fs.writeFileSync(GIT_BASH_CACHE_FILE, JSON.stringify({ path: false })); } catch { /* best-effort */ }
  return false;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function spawnDetached(cmd: string, args: string[]): void {
  if (process.platform === 'win32') {
    const bash = findGitBash();
    if (bash) {
      const shellCmd = [cmd, ...args].map(a => shellQuote(a.replace(/\\/g, '/'))).join(' ');
      const child = spawn(bash, ['-c', shellCmd], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return;
    }
    const child = spawn('cmd', ['/c', 'start', '/b', '', cmd, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
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
      spawnDetached(cmd, cmdArgs);
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
      spawnDetached(cmd, args);
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
// CardStore
// ============================================================================

class NodeCardStore implements CardStore {
  constructor(
    private readonly lookupCardPathFn: (boardDir: string, nodeId: string) => string | null,
  ) {}

  readCard(cardPath: string): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(cardPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  readSourceFileContent(boardDir: string, cardId: string, outputFile: string): unknown {
    const filePath = path.join(boardDir, cardId, outputFile);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      try { return JSON.parse(raw); }
      catch { return raw; }
    } catch {
      return null;
    }
  }

  lookupCardPath(boardDir: string, nodeId: string): string | null {
    return this.lookupCardPathFn(boardDir, nodeId);
  }
}

export function createNodeCardStore(
  lookupCardPath: (boardDir: string, nodeId: string) => string | null,
): CardStore {
  return new NodeCardStore(lookupCardPath);
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
