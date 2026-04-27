/**
 * Board Live Cards — Disk persistence + CLI for ReactiveGraph.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { lockSync } from 'proper-lockfile';
import { restore } from '../continuous-event-graph/core.js';
import type { LiveGraph, LiveGraphSnapshot } from '../continuous-event-graph/types.js';
import type { ReactiveGraph, TaskHandlerFn } from '../continuous-event-graph/reactive.js';
import { createReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createLiveGraph, snapshot } from '../continuous-event-graph/core.js';
import { schedule } from '../continuous-event-graph/schedule.js';
import type { GraphConfig, TaskConfig, GraphEvent } from '../event-graph/types.js';
import type { LiveCard } from '../continuous-event-graph/live-cards-bridge.js';
import type { Journal } from '../continuous-event-graph/journal.js';
import { CardCompute } from '../card-compute/index.js';
import type { ComputeNode, ComputeStep, ComputeSource } from '../card-compute/index.js';
import { validateLiveCardDefinition } from '../card-compute/schema-validator.js';
import { createBoardCommandHandlers } from './board-live-cards-cli-board-commands.js';
import { createCallbackCommandHandlers } from './board-live-cards-cli-callbacks.js';
import { createNonCoreCommandHandlers } from './board-live-cards-cli-noncore.js';

const BOARD_FILE = 'board-graph.json';
const JOURNAL_FILE = 'board-journal.jsonl';
const TASK_EXECUTOR_LOG_FILE = 'task-executor.jsonl';
const INFERENCE_ADAPTER_LOG_FILE = 'inference-adapter.jsonl';
const INVENTORY_FILE = 'cards-inventory.jsonl';
const RUNTIME_OUT_FILE = '.runtime-out';
const DEFAULT_RUNTIME_OUT_DIR = 'runtime-out';
const RUNTIME_STATUS_FILE = 'board-livegraph-status.json';
const RUNTIME_CARDS_DIR = 'cards';
const RUNTIME_DATA_OBJECTS_DIR = 'data-objects';
const INFERENCE_ADAPTER_FILE = '.inference-adapter';
const TASK_EXECUTOR_FILE = '.task-executor';
const DEFAULT_TASK_COMPLETION_RULE = 'all_required_sources_fetched';

/** Parsed content of a .task-executor file (JSON or plain-text fallback). */
interface TaskExecutorConfig {
  command: string;
  extra?: Record<string, unknown>;
}

/**
 * Read and parse a .task-executor file.
 * Supports JSON format: { "command": "...", "extra": { ... } }
 * Falls back to treating the entire content as a plain command string (backward compat).
 * The `extra` bag is merged blindly into each source payload before invoking the executor.
 */
function readTaskExecutorConfig(boardDir: string): TaskExecutorConfig | undefined {
  const executorFile = path.join(boardDir, TASK_EXECUTOR_FILE);
  if (!fs.existsSync(executorFile)) return undefined;
  const raw = fs.readFileSync(executorFile, 'utf-8').trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string') {
      return parsed as TaskExecutorConfig;
    }
  } catch { /* not JSON — treat as plain command */ }
  return { command: raw };
}
const EMPTY_CONFIG: GraphConfig = { settings: { completion: 'manual', refreshStrategy: 'data-changed' }, tasks: {} } as GraphConfig;

/** Envelope stored in board-graph.json — wraps the LiveGraph snapshot with journal pointer. */
export interface BoardEnvelope {
  lastDrainedJournalId: string;
  graph: LiveGraphSnapshot;
}

// ============================================================================
// Board Journal — append-only JSONL with GUID IDs
// ============================================================================

export interface JournalEntry {
  id: string;
  event: GraphEvent;
}

export class BoardJournal implements Journal {
  private readonly journalPath: string;
  private lastDrainedId: string;

  constructor(journalPath: string, lastDrainedJournalId: string) {
    this.journalPath = journalPath;
    this.lastDrainedId = lastDrainedJournalId;
  }

  append(event: GraphEvent): void {
    const entry: JournalEntry = { id: randomUUID(), event };
    fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  drain(): GraphEvent[] {
    if (!fs.existsSync(this.journalPath)) return [];
    const content = fs.readFileSync(this.journalPath, 'utf-8').trim();
    if (!content) return [];
    const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));

    // Find the index of the last drained entry; take everything after it
    let startIdx = 0;
    if (this.lastDrainedId) {
      const drainedIdx = entries.findIndex(e => e.id === this.lastDrainedId);
      if (drainedIdx !== -1) startIdx = drainedIdx + 1;
    }

    const undrained = entries.slice(startIdx);
    if (undrained.length > 0) {
      this.lastDrainedId = undrained[undrained.length - 1].id;
    }
    return undrained.map(e => e.event);
  }

  get size(): number {
    if (!fs.existsSync(this.journalPath)) return 0;
    const content = fs.readFileSync(this.journalPath, 'utf-8').trim();
    if (!content) return 0;
    const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));
    if (!this.lastDrainedId) return entries.length;
    const drainedIdx = entries.findIndex(e => e.id === this.lastDrainedId);
    return drainedIdx === -1 ? entries.length : entries.length - drainedIdx - 1;
  }

  get lastDrainedJournalId(): string {
    return this.lastDrainedId;
  }
}

// ============================================================================
// Cards inventory
// ============================================================================

export interface CardInventoryEntry {
  cardId: string;
  cardFilePath: string;
  addedAt: string;
}

export interface CardInventoryIndex {
  byCardId: Map<string, CardInventoryEntry>;
  byCardPath: Map<string, CardInventoryEntry>;
}

export function readCardInventory(boardDir: string): CardInventoryEntry[] {
  const inventoryPath = path.join(boardDir, INVENTORY_FILE);
  if (!fs.existsSync(inventoryPath)) return [];
  const lines = fs.readFileSync(inventoryPath, 'utf-8').split('\n').filter(l => l.trim());
  return lines.map(l => JSON.parse(l) as CardInventoryEntry);
}

export function lookupCardPath(boardDir: string, cardId: string): string | null {
  const entries = readCardInventory(boardDir);
  const entry = entries.find(e => e.cardId === cardId);
  return entry?.cardFilePath ?? null;
}

export function appendCardInventory(boardDir: string, entry: CardInventoryEntry): void {
  const inventoryPath = path.join(boardDir, INVENTORY_FILE);
  const normalized: CardInventoryEntry = { ...entry, cardFilePath: path.resolve(entry.cardFilePath) };
  fs.appendFileSync(inventoryPath, JSON.stringify(normalized) + '\n');
}

export function buildCardInventoryIndex(boardDir: string): CardInventoryIndex {
  const byCardId = new Map<string, CardInventoryEntry>();
  const byCardPath = new Map<string, CardInventoryEntry>();

  for (const entry of readCardInventory(boardDir)) {
    const normalizedPath = path.resolve(entry.cardFilePath);
    const normalizedEntry: CardInventoryEntry = {
      ...entry,
      cardFilePath: normalizedPath,
    };

    const existingById = byCardId.get(entry.cardId);
    if (existingById && existingById.cardFilePath !== normalizedPath) {
      throw new Error(
        `Inventory invariant violation: card id "${entry.cardId}" maps to multiple files: ` +
        `"${existingById.cardFilePath}" and "${normalizedPath}"`
      );
    }

    const existingByPath = byCardPath.get(normalizedPath);
    if (existingByPath && existingByPath.cardId !== entry.cardId) {
      throw new Error(
        `Inventory invariant violation: file "${normalizedPath}" maps to multiple ids: ` +
        `"${existingByPath.cardId}" and "${entry.cardId}"`
      );
    }

    byCardId.set(entry.cardId, normalizedEntry);
    byCardPath.set(normalizedPath, normalizedEntry);
  }

  return { byCardId, byCardPath };
}

// ============================================================================
// Library
// ============================================================================

/**
 * Initialize a board directory.
 * - Dir doesn't exist → create it, write empty board-graph.json
 * - Dir exists + valid board-graph.json → no-op, return 'exists'
 * - Dir exists + non-empty (no valid board-graph.json) → throw
 */
export function initBoard(dir: string): 'created' | 'exists' {
  const boardPath = path.join(dir, BOARD_FILE);

  if (fs.existsSync(boardPath)) {
    // Validate it's a real board envelope
    const envelope = JSON.parse(fs.readFileSync(boardPath, 'utf-8')) as BoardEnvelope;
    restore(envelope.graph);
    return 'exists';
  }

  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(`Directory "${dir}" is not empty and has no valid ${BOARD_FILE}`);
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const live = createLiveGraph(EMPTY_CONFIG);
  const snap = snapshot(live);
  const envelope: BoardEnvelope = { lastDrainedJournalId: '', graph: snap };
  fs.writeFileSync(boardPath, JSON.stringify(envelope, null, 2));
  return 'created';
}

export function loadBoardEnvelope(dir: string): BoardEnvelope {
  const raw = fs.readFileSync(path.join(dir, BOARD_FILE), 'utf-8');
  return JSON.parse(raw) as BoardEnvelope;
}

export function loadBoard(dir: string): LiveGraph {
  const envelope = loadBoardEnvelope(dir);
  return restore(envelope.graph);
}

export function saveBoard(dir: string, rg: ReactiveGraph, journal: BoardJournal): void {
  const snap = rg.snapshot();
  const envelope: BoardEnvelope = {
    lastDrainedJournalId: journal.lastDrainedJournalId,
    graph: snap,
  };
  writeJsonAtomic(path.join(dir, BOARD_FILE), envelope);

  // Publish status snapshot in the same persistence path as board writes.
  const live = restore(snap);
  const statusObject = buildBoardStatusObject(dir, live);
  writeJsonAtomic(resolveStatusSnapshotPath(dir), statusObject);
}

function runtimeOutConfigPath(boardDir: string): string {
  return path.join(boardDir, RUNTIME_OUT_FILE);
}

function resolveConfiguredRuntimeOutDir(boardDir: string): string {
  const cfgPath = runtimeOutConfigPath(boardDir);
  if (fs.existsSync(cfgPath)) {
    const configured = fs.readFileSync(cfgPath, 'utf-8').trim();
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.resolve(boardDir, configured);
    }
  }

  const defaultDir = path.join(boardDir, DEFAULT_RUNTIME_OUT_DIR);
  fs.writeFileSync(cfgPath, defaultDir, 'utf-8');
  return defaultDir;
}

function configureRuntimeOutDir(boardDir: string, runtimeOut?: string): string {
  let resolved: string;
  if (runtimeOut) {
    resolved = path.isAbsolute(runtimeOut) ? runtimeOut : path.resolve(boardDir, runtimeOut);
  } else {
    resolved = path.join(boardDir, DEFAULT_RUNTIME_OUT_DIR);
  }

  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(runtimeOutConfigPath(boardDir), resolved, 'utf-8');
  return resolved;
}

function resolveStatusSnapshotPath(boardDir: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_STATUS_FILE);
}

function resolveComputedValuesPath(boardDir: string, cardId: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_CARDS_DIR, `${cardId}.computed.json`);
}

function resolveDataObjectsDirPath(boardDir: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_DATA_OBJECTS_DIR);
}

function toDataObjectFileName(token: string): string {
  // Keep token recognizable in filenames while avoiding path traversal.
  return token.replace(/[\\/]/g, '__');
}

function writeRuntimeDataObjects(boardDir: string, data: Record<string, unknown>): void {
  for (const [token, payload] of Object.entries(data)) {
    if (!token) continue;
    const fileName = toDataObjectFileName(token);
    if (!fileName) continue;
    const filePath = path.join(resolveDataObjectsDirPath(boardDir), fileName);
    writeJsonAtomic(filePath, payload);
  }
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Acquire an exclusive lock on the board, run `fn`, then release.
 * Uses proper-lockfile on board-graph.json.
 */
export function withBoardLock<T>(boardDir: string, fn: () => T): T {
  const boardPath = path.join(boardDir, BOARD_FILE);
  const release = lockSync(boardPath, { retries: { retries: 5, minTimeout: 100 } });
  try {
    return fn();
  } finally {
    release();
  }
}

// ============================================================================
// Standalone journal append + opportunistic drain
// ============================================================================

/**
 * Decode a callback token → { taskName } or null if malformed.
 * Mirrors the private encodeCallbackToken format in reactive.ts.
 */
function decodeCallbackToken(token: string): { taskName: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (typeof payload?.t === 'string') return { taskName: payload.t };
    return null;
  } catch { return null; }
}

// ============================================================================
// Source token — per-source opaque token carrying all delivery metadata
// ============================================================================

export interface SourceTokenPayload {
  /** Original callback token from the reactive graph (encodes taskName) */
  cbk: string;
  /** Board directory (absolute path) */
  rg: string;
  /** Card id */
  cid: string;
  /** source_defs[].bindTo */
  b: string;
  /** source_defs[].outputFile (relative to boardDir) */
  d: string;
  /** Per-source invocation checksum */
  cs?: string;
}

export function encodeSourceToken(payload: SourceTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeSourceToken(token: string): SourceTokenPayload | null {
  try {
    const p = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (typeof p?.cbk === 'string' && typeof p?.cid === 'string' && typeof p?.b === 'string' && typeof p?.d === 'string') {
      return p as SourceTokenPayload;
    }
    return null;
  } catch { return null; }
}

// ============================================================================
// Runtime state sidecar — <cardId>.runtime.json
// ============================================================================

export interface SourceRuntimeEntry {
  lastRequestedAt?: string;
  lastFetchedAt?: string;
  lastError?: string;
  /** Timestamp of the most recent card-handler dispatch — updated on every fresh invocation.
   * Replaces checksum-based gating: a source fetch is needed whenever
   * lastFetchedAt is absent or older than queueRequestedAt. */
  queueRequestedAt?: string;
}

export interface InferenceRuntimeEntry {
  lastRequestedAt?: string;
  lastFetchedAt?: string;
  lastError?: string;
  /** Same semantics as SourceRuntimeEntry.queueRequestedAt. */
  queueRequestedAt?: string;
}

type FetchRuntimeEntry = SourceRuntimeEntry | InferenceRuntimeEntry;

function markRequested(entry: FetchRuntimeEntry, requestedAt: string): void {
  entry.lastRequestedAt = requestedAt;
}

function markFetchFailed(entry: FetchRuntimeEntry, reason: string): void {
  entry.lastError = reason;
  delete entry.lastFetchedAt;
}

function markFetchCompleted(entry: FetchRuntimeEntry, fetchedAt: string): void {
  entry.lastFetchedAt = fetchedAt;
  delete entry.lastError;
}

export function isSourceInFlight(entry: FetchRuntimeEntry | undefined): boolean {
  if (!entry?.lastRequestedAt) return false;
  return !entry.lastFetchedAt || entry.lastFetchedAt < entry.lastRequestedAt;
}

/**
 * Decide what to do with a source/inference fetch given the current runtime entry
 * and the timestamp of the latest card-handler dispatch (queueRequestedAt).
 *
 * - 'dispatch' : fetch not yet started for this run, or previous fetch predates the request
 * - 'in-flight': fetch is already running for this run — update queueRequestedAt and wait
 * - 'idle'     : fetch already completed for this run — nothing to do
 */
export function decideSourceAction(
  entry: FetchRuntimeEntry | undefined,
  queueRequestedAt: string,
): 'dispatch' | 'in-flight' | 'idle' {
  if (!entry?.lastRequestedAt) return 'dispatch';
  const inFlight = isSourceInFlight(entry);
  if (inFlight) return 'in-flight';                           // wait; caller updates queueRequestedAt
  if (!entry.lastFetchedAt) return 'dispatch';                // requested but never fetched
  if (entry.lastFetchedAt < queueRequestedAt) return 'dispatch'; // fetched before current run
  return 'idle';                                              // already fetched for this run
}

export function nextEntryAfterFetchDelivery<T extends FetchRuntimeEntry>(
  entry: T,
  fetchedAt: string,
): T {
  const next = { ...entry };
  markFetchCompleted(next, fetchedAt);
  // If queueRequestedAt is newer than the fetch just completed, the caller
  // already updated queueRequestedAt while the fetch was in-flight.
  // The next card-handler invocation will see lastFetchedAt < queueRequestedAt
  // and dispatch again — no special queuing needed here.
  return next as T;
}

export function nextEntryAfterFetchFailure<T extends FetchRuntimeEntry>(
  entry: T,
  reason: string,
): T {
  const next = { ...entry };
  markFetchFailed(next, reason);
  return next as T;
}

export interface CardRuntimeState {
  _sources: Record<string, SourceRuntimeEntry>;
  _inferenceEntry?: InferenceRuntimeEntry;
  _lastExecutionCount?: number;
}

function runtimePath(boardDir: string, cardId: string): string {
  return path.join(boardDir, cardId, 'runtime.json');
}

function readRuntimeState(boardDir: string, cardId: string): CardRuntimeState {
  const p = runtimePath(boardDir, cardId);
  if (!fs.existsSync(p)) return { _sources: {} };
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as CardRuntimeState; }
  catch { return { _sources: {} }; }
}

function writeRuntimeState(boardDir: string, cardId: string, state: CardRuntimeState): void {
  const p = runtimePath(boardDir, cardId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

/**
 * Append a raw event to the journal file. No lock, no file read.
 * Safe for hundreds of concurrent callers (appendFileSync is atomic for small writes).
 */
export function appendEventToJournal(boardDir: string, event: GraphEvent): void {
  const journalPath = path.join(boardDir, JOURNAL_FILE);
  const entry: JournalEntry = { id: randomUUID(), event };
  fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Read journal entries after the given ID. Pure file read, no mutation.
 */
export function getUndrainedEntries(boardDir: string, lastDrainedId: string): JournalEntry[] {
  const journalPath = path.join(boardDir, JOURNAL_FILE);
  if (!fs.existsSync(journalPath)) return [];
  const content = fs.readFileSync(journalPath, 'utf-8').trim();
  if (!content) return [];
  const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));
  if (!lastDrainedId) return entries;
  const idx = entries.findIndex(e => e.id === lastDrainedId);
  return idx === -1 ? entries : entries.slice(idx + 1);
}

function determineLatestPendingAccumulated(boardDir: string): number {
  const boardPath = path.join(boardDir, BOARD_FILE);
  if (!fs.existsSync(boardPath)) return 0;
  try {
    const envelope = loadBoardEnvelope(boardDir);
    return getUndrainedEntries(boardDir, envelope.lastDrainedJournalId).length;
  } catch {
    return 0;
  }
}

function shouldUseShellForCommand(cmd: string, forceShell?: boolean): boolean {
  if (typeof forceShell === 'boolean') return forceShell;
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
}

/** Cached git-bash path (resolved once per process, persisted to disk across invocations). */
let _gitBashPath: string | false | undefined;
const GIT_BASH_CACHE_FILE = path.join(os.tmpdir(), '.board-live-cards-git-bash-cache.json');

function findGitBash(): string | false {
  if (_gitBashPath !== undefined) return _gitBashPath;
  if (process.platform !== 'win32') return (_gitBashPath = false);

  // Try disk cache first
  try {
    const cached = JSON.parse(fs.readFileSync(GIT_BASH_CACHE_FILE, 'utf8'));
    if (cached.path === false || (typeof cached.path === 'string' && fs.existsSync(cached.path))) {
      return (_gitBashPath = cached.path);
    }
  } catch { /* cache miss or corrupt — probe fresh */ }

  const candidates = [
    process.env.SHELL,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Git', 'usr', 'bin', 'bash.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Git', 'bin', 'bash.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) {
    if (c && /bash(\.exe)?$/i.test(c) && fs.existsSync(c)) {
      _gitBashPath = c;
      try { fs.writeFileSync(GIT_BASH_CACHE_FILE, JSON.stringify({ path: c })); } catch { /* best-effort */ }
      return _gitBashPath;
    }
  }
  _gitBashPath = false;
  try { fs.writeFileSync(GIT_BASH_CACHE_FILE, JSON.stringify({ path: false })); } catch { /* best-effort */ }
  return _gitBashPath;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function spawnDetachedCommand(cmd: string, args: string[]): void {
  if (process.platform === 'win32') {
    const bash = findGitBash();
    if (bash) {
      // Git-bash background: no console popup, survives parent exit.
      const shellCmd = [cmd, ...args].map((a) => shellQuote(a.replace(/\\/g, '/'))).join(' ');
      const child = spawn(bash, ['-c', shellCmd], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return;
    }
    // Fallback: cmd /c start /b + detached so child survives parent exit.
    const child = spawn('cmd', ['/c', 'start', '/b', '', cmd, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }
  // Unix: straightforward detached spawn.
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function execCommandSync(
  cmd: string,
  args: string[],
  options?: {
    shell?: boolean;
    timeout?: number;
    encoding?: BufferEncoding;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): string {
  const output = execFileSync(cmd, args, {
    shell: shouldUseShellForCommand(cmd, options?.shell),
    timeout: options?.timeout,
    encoding: options?.encoding,
    cwd: options?.cwd,
    windowsHide: true,
    env: options?.env,
  });
  return typeof output === 'string' ? output : output.toString('utf-8');
}

function execCommandAsync(
  cmd: string,
  args: string[],
  callback: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  execFile(
    cmd,
    args,
    { shell: shouldUseShellForCommand(cmd), encoding: 'utf8', windowsHide: true },
    (err, stdout, stderr) => callback(err ?? null, stdout, stderr),
  );
}

function splitCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;

  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (quote) {
    throw new Error(`Unterminated quote in command: ${command}`);
  }

  if (current) tokens.push(current);
  return tokens;
}

function resolveCommandInvocation(rawCmd: string, rawArgs: string[]): { cmd: string; args: string[] } {
  if (/^(node|node\.exe)$/i.test(rawCmd)) {
    return { cmd: process.execPath, args: rawArgs };
  }
  // Keep script-based commands consistent for source and inference paths.
  if (/\.m?js$/i.test(rawCmd)) {
    return { cmd: process.execPath, args: [rawCmd, ...rawArgs] };
  }
  return { cmd: rawCmd, args: rawArgs };
}

function spawnDetachedProcessAccumulatedWorker(boardDir: string): boolean {
  const { cmd, args: cliArgs } = getCliInvocation('process-accumulated-events', ['--rg', boardDir, '--inline-loop']);
  try {
    spawnDetachedCommand(cmd, cliArgs);
    return true;
  } catch {
    return false;
  }
}

async function processAccumulatedEventsInlineLoop(boardDir: string, settleDelayMs = 50): Promise<boolean> {
  while (determineLatestPendingAccumulated(boardDir) > 0) {
    const ran = await processAccumulatedEvents(boardDir);
    if (!ran) return false;
    await new Promise<void>(resolve => setTimeout(resolve, settleDelayMs));
  }
  return true;
}

function shouldAvoidDetachedProcessSpawn(): boolean {
  return process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1';
}

/**
 * Run one lock-guarded processing pass for this board.
 *
 * GUARANTEE (single-pass only):
 * - At most one process performs this pass at a time (board lock).
 * - If lock is acquired, exactly one drain/apply/save cycle is executed.
 * - If lock is busy, returns false immediately (no waiting).
 *
 * This function does NOT guarantee full settlement; it only advances the baton
 * by one cycle in the relay model.
 */
export async function processAccumulatedEvents(boardDir: string): Promise<boolean> {
  const boardPath = path.join(boardDir, BOARD_FILE);
  let release: (() => void) | undefined;
  try {
    release = lockSync(boardPath, { retries: 0 });
  } catch {
    // Lock held by another process — it will drain our entries
    return false;
  }
  try {
    const { rg, journal } = createBoardReactiveGraph(boardDir);
    // Explicitly drain the external journal and push events into the reactive graph.
    // The engine never reads from external storage — the caller owns that boundary.
    const undrained = journal.drain();
    rg.pushAll(undrained);
    await rg.dispose({ wait: true });
    saveBoard(boardDir, rg, journal);
    return true;
  } finally {
    release!();
  }
}

/**
 * Schedule continued draining until the board eventually settles.
 *
 * GUARANTEE (system-level eventual progress):
 * - Default behavior launches a detached background worker process that runs
 *   `process-accumulated-events --inline-loop`.
 * - Returns quickly to caller; does not synchronously wait for settlement.
 * - Under relay assumptions, pending entries eventually drain to zero:
 *   1) at least one runner continues, 2) no crash/forced exit in relay window,
 *   3) lock remains healthy, 4) new events do not arrive forever.
 *
 * INTERNAL MODE:
 * - `inlineLoop: true` executes the while(pending) loop in the current process.
 * - Used by the worker command to avoid recursive worker spawning.
 */
export async function processAccumulatedEventsInfinitePass(
  boardDir: string,
  settleDelayMs = 50,
  options?: { inlineLoop?: boolean },
): Promise<boolean> {
  if (options?.inlineLoop || shouldAvoidDetachedProcessSpawn()) {
    return processAccumulatedEventsInlineLoop(boardDir, settleDelayMs);
  }
  return spawnDetachedProcessAccumulatedWorker(boardDir);
}

/**
 * Forced drain entrypoint: first run one immediate pass, then delegate to
 * infinite-pass continuation.
 *
 * GUARANTEE:
 * - In default mode, this guarantees immediate forward progress (single pass)
 *   and guaranteed scheduling of eventual continuation (background worker).
 * - In `inlineLoop` mode, this runs full in-process settle loop and returns
 *   only after pending reaches zero (or lock contention aborts loop).
 */
export async function processAccumulatedEventsForced(
  boardDir: string,
  options?: { inlineLoop?: boolean },
): Promise<void> {
  await processAccumulatedEvents(boardDir);
  await processAccumulatedEventsInfinitePass(boardDir, 50, options);
}

// ============================================================================
// Card transform
// ============================================================================

export type BoardLiveCard = LiveCard;

/**
 * Transform a LiveCard into a TaskConfig for the reactive graph.
 *
 * Every card gets handler: 'card-handler'.
 * The handler inspects the card and decides what to do:
 * run compute, invoke source_defs.
 */
export function liveCardToTaskConfig(card: BoardLiveCard): TaskConfig {
  const requires = card.requires;
  const provides = card.provides?.map(p => p.bindTo) ?? [];

  return {
    requires: requires && requires.length > 0 ? requires : undefined,
    provides,
    taskHandlers: ['card-handler'],
    description: card.meta?.title ?? card.id,
  };
}

// ============================================================================
// Reactive graph factory
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * Generalized CLI invocation: determines how to invoke this script in current environment.
 * Returns { cmd, args } suitable for execFile() or execFileSync().
 */
function getCliInvocation(command: string, args: string[]): { cmd: string; args: string[] } {
  const jsPath = path.join(__dirname, 'board-live-cards-cli.js');
  if (fs.existsSync(jsPath)) {
    return { cmd: process.execPath, args: [jsPath, command, ...args] };
  }

  const tsPath = path.join(__dirname, 'board-live-cards-cli.ts');
  if (fs.existsSync(tsPath) && fs.existsSync(LOCAL_TSX_CLI)) {
    return { cmd: process.execPath, args: [LOCAL_TSX_CLI, tsPath, command, ...args] };
  }

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { cmd: npxCmd, args: ['tsx', tsPath, command, ...args] };
}

function invokeRunSources(
  boardDir: string,
  cardPath: string,
  callbackToken: string,
  callback: (err: Error | null) => void,
): void {
  const args = ['--card', cardPath, '--token', callbackToken, '--rg', boardDir];
  const { cmd, args: cmdArgs } = getCliInvocation('run-sourcedefs-internal', args);
  try {
    spawnDetachedCommand(cmd, cmdArgs);
    callback(null);
  } catch (err) {
    callback(err instanceof Error ? err : new Error(String(err)));
  }
}

function invokeRunInference(boardDir: string, cardId: string, inputFile: string, callbackToken: string, checksum: string | undefined, callback: (err: Error | null) => void): void {
  const inferenceToken = encodeSourceToken({ cbk: callbackToken, rg: boardDir, cid: cardId, b: '', d: '', cs: checksum });
  const { cmd, args } = getCliInvocation('run-inference-internal', ['--in', inputFile, '--token', inferenceToken]);
  try {
    spawnDetachedCommand(cmd, args);
    callback(null);
  } catch (err) {
    callback(err instanceof Error ? err : new Error(String(err)));
  }
}



function appendTaskExecutorLog(
  boardDir: string,
  hydratedSource: unknown,
  mode: 'external-task-executor' | 'built-in-run-source-fetch',
): void {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      mode,
      hydratedSource,
    };
    fs.appendFileSync(path.join(boardDir, TASK_EXECUTOR_LOG_FILE), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (logErr) {
    console.error(`[task-executor-log] append failed: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
  }
}

function appendInferenceAdapterLog(boardDir: string, cardId: string, payload: unknown): void {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      cardId,
      payload,
    };
    fs.appendFileSync(path.join(boardDir, INFERENCE_ADAPTER_LOG_FILE), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (logErr) {
    console.error(`[inference-adapter-log] append failed: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
  }
}

function invokeSourceDataFetched(sourceToken: string, tmpFile: string, callback: (err: Error | null) => void): void {
  const { cmd, args } = getCliInvocation('source-data-fetched', ['--tmp', tmpFile, '--token', sourceToken]);
  execCommandAsync(cmd, args, (err, stdout, stderr) => {
    if (err) console.error(`[source-data-fetched] call failed:`, err.message);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
    callback(err);
  });
}

function invokeSourceDataFetchFailure(sourceToken: string, reason: string, callback: (err: Error | null) => void): void {
  const { cmd, args } = getCliInvocation('source-data-fetch-failure', ['--token', sourceToken, '--reason', reason]);
  execCommandAsync(cmd, args, (err) => callback(err));
}

/**
 * Spin up a ReactiveGraph from a board directory with all handlers wired.
 *
 * Single handler:
 *   card-handler — reads card.json, loads sourcesData from outputFiles, runs CardCompute,
 *                  checks undelivered source_defs, emits task-completed or spawns run-sourcedefs-internal.
 *                  Fire & forget — returns 'task-initiated' immediately.
 */
export interface BoardReactiveGraph {
  rg: ReactiveGraph;
  journal: BoardJournal;
}

export function createBoardReactiveGraph(boardDir: string): BoardReactiveGraph {
  const envelope = loadBoardEnvelope(boardDir);
  const live = restore(envelope.graph);
  const journalPath = path.join(boardDir, JOURNAL_FILE);
  const journal = new BoardJournal(journalPath, envelope.lastDrainedJournalId);

  const handlers: Record<string, TaskHandlerFn> = {
    'card-handler': async (input) => {
      const cardPath = lookupCardPath(boardDir, input.nodeId);
      if (!cardPath) return 'task-initiate-failure';

      const card = JSON.parse(fs.readFileSync(cardPath, 'utf-8')) as Record<string, unknown>;
      const cardId = card.id as string;
      const cardState = (card.card_data ?? {}) as Record<string, unknown>;
      const allSources: ComputeSource[] = (card.source_defs ?? []) as ComputeSource[];
      // optionalForCompletionGating defaults to false when absent.
      const requiredSources = allSources.filter(s => s.optionalForCompletionGating !== true);

        // Read (or initialise) the runtime sidecar
        const runtime = readRuntimeState(boardDir, cardId);
        let runtimeDirty = false;

        // ---- If the task was restarted, clear stale source/inference state ----
        const currentExecutionCount = input.taskState?.executionCount ?? 0;
        if (typeof runtime._lastExecutionCount === 'number' && runtime._lastExecutionCount !== currentExecutionCount) {
          runtime._sources = {};
          runtime._inferenceEntry = undefined;
        }
        if (runtime._lastExecutionCount !== currentExecutionCount) {
          runtime._lastExecutionCount = currentExecutionCount;
          runtimeDirty = true;
        }

        // ---- Handle a task-progress re-invocation (source delivery or failure) ----
        if (input.update) {
          const u = input.update;
          const outputFile = u.outputFile as string;
          // Only process source updates (which have outputFile); skip non-source updates like inference-done
          if (outputFile) {
            if (!runtime._sources[outputFile]) runtime._sources[outputFile] = {};
            const entry = runtime._sources[outputFile];

            if (u.failure) {
              // Source fetch failed — record error, stay in-progress
              runtime._sources[outputFile] = nextEntryAfterFetchFailure(entry, (u.reason as string | undefined) ?? 'unknown');
              runtimeDirty = true;
            } else {
              // Successful delivery — output file already in place by CLI
              runtime._sources[outputFile] = nextEntryAfterFetchDelivery(
                entry,
                (u.fetchedAt as string | undefined) ?? new Date().toISOString(),
              );
              runtimeDirty = true;
            }

            if (runtimeDirty) writeRuntimeState(boardDir, cardId, runtime);
          }
        }

      // ---- Load sourcesData from outputFiles ----
      const sourcesData: Record<string, unknown> = {};
      for (const src of allSources) {
        if (src.outputFile) {
          const filePath = path.join(boardDir, cardId, src.outputFile);
          if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            try { sourcesData[src.bindTo] = JSON.parse(raw); }
            catch { sourcesData[src.bindTo] = raw; }
          }
        }
      }

      // ---- Run compute ----
      // input.state[token] = the full task-completed data object from the producer
      // (e.g. { orders: [...] }). Unwrap to the specific token value so that
      // compute expressions see requires.orders = [...] not requires.orders = { orders: [...] }.
      const requires: Record<string, unknown> = {};
      for (const [token, taskData] of Object.entries(input.state ?? {})) {
        if (taskData !== null && typeof taskData === 'object' && !Array.isArray(taskData)) {
          const unwrapped = (taskData as Record<string, unknown>)[token];
          requires[token] = unwrapped !== undefined ? unwrapped : taskData;
        } else {
          requires[token] = taskData;
        }
      }

      const computeNode: ComputeNode = {
        id: cardId,
        card_data: { ...cardState },
        requires,
        source_defs: allSources,
        compute: card.compute as ComputeStep[] | undefined,
      };
      // Always populate _sourcesData so resolve("source_defs.*") works even without compute steps.
      computeNode._sourcesData = sourcesData;
      if (card.compute) {
        await CardCompute.run(computeNode, { sourcesData });
      }
      const cvPath = resolveComputedValuesPath(boardDir, cardId);
      writeJsonAtomic(cvPath, {
        schema_version: 'v1',
        card_id: cardId,
        computed_values: computeNode.computed_values ?? {},
      });

      // Build enriched source payloads and checksums up-front so dispatch gating
      // can react to input changes, not only timestamp delivery state.
      const enrichedCard = { ...card };
      const enrichedSources = await CardCompute.enrichSources(
        (Array.isArray(card.source_defs) ? card.source_defs : undefined),
        {
          card_data: card.card_data as Record<string, unknown>,
          requires,
          sourcesData,
          computed_values: computeNode.computed_values,
        }
      );
      const sourceCwd = path.dirname(cardPath);
      enrichedCard.source_defs = Array.isArray(enrichedSources)
        ? enrichedSources.map((src) => ({
            ...src,
            cwd: typeof src.cwd === 'string' && src.cwd ? src.cwd : sourceCwd,
            boardDir: typeof src.boardDir === 'string' && src.boardDir ? src.boardDir : boardDir,
          }))
        : enrichedSources;

      const enrichedByOutput = new Map<string, unknown>();
      for (const src of (Array.isArray(enrichedCard.source_defs) ? enrichedCard.source_defs : [])) {
        const outputFile = (src as { outputFile?: unknown }).outputFile;
        if (typeof outputFile === 'string' && outputFile) {
          enrichedByOutput.set(outputFile, src);
        }
      }

        // ---- Delivery check: source fetched after queueRequestedAt for all required source_defs ----
        // queueRequestedAt is stamped on every fresh card-handler dispatch (not-started / completed).
        // A source needs fetching when: never fetched, or lastFetchedAt < queueRequestedAt.
        // While a fetch is in-flight we just update queueRequestedAt so the next completion
        // sees the latest request and re-fetches if needed.
        const now = new Date().toISOString();
        // Use the invocation time as queueRequestedAt for this run.
        const runQueuedAt = input.update ? undefined : now; // only stamp on fresh dispatch, not task-progress

        const undeliveredRequired = requiredSources.filter(s => {
          const outputFile = s.outputFile;
          if (typeof outputFile !== 'string' || !outputFile) return true;
          if (!runtime._sources[outputFile]) runtime._sources[outputFile] = {};
          const entry = runtime._sources[outputFile];
          // On a fresh dispatch, update queueRequestedAt to the current time.
          if (runQueuedAt) {
            entry.queueRequestedAt = runQueuedAt;
            runtimeDirty = true;
          }
          const qrt = entry.queueRequestedAt ?? entry.lastRequestedAt ?? now;
          const action = decideSourceAction(entry, qrt);
          if (action === 'in-flight') return false; // wait; queueRequestedAt already updated above
          return action === 'dispatch';
        });

      if (runtimeDirty) writeRuntimeState(boardDir, cardId, runtime);

      if (undeliveredRequired.length > 0) {
          let stampedAny = false;
          for (const src of undeliveredRequired) {
            const outputFile = src.outputFile;
            if (typeof outputFile !== 'string' || !outputFile) continue;
            const entry = runtime._sources[outputFile] ?? {};
            markRequested(entry, now);
            runtime._sources[outputFile] = entry;
            stampedAny = true;
          }
          if (stampedAny) writeRuntimeState(boardDir, cardId, runtime);
          if (!stampedAny) return 'task-initiated';

          // Write enriched card to temp location for this invocation
          const enrichedCardPath = path.join(os.tmpdir(), `card-enriched-${cardId}-${Date.now()}.json`);
          fs.writeFileSync(enrichedCardPath, JSON.stringify(enrichedCard, null, 2), 'utf-8');

          invokeRunSources(boardDir, enrichedCardPath, input.callbackToken, (err) => {
            if (err) {
              console.error(`[card-handler] ${input.nodeId}:`, err.message);
              try { fs.unlinkSync(enrichedCardPath); } catch {}
            }
          });
        return 'task-initiated';
      }

      // ---- All required source_defs delivered — build provides payload ----
      const providesBindings = (card.provides ?? []) as { bindTo: string; ref: string }[];
      const data: Record<string, unknown> = {};
      for (const { bindTo, ref } of providesBindings) {
        data[bindTo] = CardCompute.resolve(computeNode, ref);
      }

      const completionRule = typeof card.when_is_task_completed === 'string' && card.when_is_task_completed.trim()
        ? card.when_is_task_completed.trim()
        : DEFAULT_TASK_COMPLETION_RULE;

      const cardData = card.card_data as Record<string, unknown> | undefined;
      const llmCompletion = (cardData?.llm_task_completion_inference ?? {}) as Record<string, unknown>;
      const isLlmTaskCompleted = llmCompletion.isTaskCompleted === true;
      // inferenceRequested lives in the runtime sidecar, not the card file
      const inferenceEntry = runtime._inferenceEntry ?? {};
      const inferenceRequestedAt = typeof inferenceEntry.lastRequestedAt === 'string'
        ? inferenceEntry.lastRequestedAt
        : undefined;
      const inferenceCompletedAt = typeof llmCompletion.inferenceCompletedAt === 'string'
        ? llmCompletion.inferenceCompletedAt
        : undefined;
      const inferencePending = !!inferenceRequestedAt
        && (!inferenceCompletedAt || inferenceCompletedAt < inferenceRequestedAt);

      const latestRequiredSourceFetchedAt = requiredSources.reduce<string | undefined>((latest, src) => {
        const fetchedAt = runtime._sources[src.outputFile]?.lastFetchedAt;
        if (typeof fetchedAt !== 'string') return latest;
        if (!latest || fetchedAt > latest) return fetchedAt;
        return latest;
      }, undefined);

      const shouldRequestInference = !inferenceRequestedAt
        || !inferenceCompletedAt
        || (!!latestRequiredSourceFetchedAt && latestRequiredSourceFetchedAt > inferenceCompletedAt);

      if (completionRule !== DEFAULT_TASK_COMPLETION_RULE) {
        if (isLlmTaskCompleted) {
          // Card carries adapter-evaluated completion; proceed with deterministic completion path below.
        } else if (inferencePending) {
          // Request already in flight. Wait for completion callback.
          return 'task-initiated';
        } else if (!shouldRequestInference) {
          // Latest inference has completed and inputs are unchanged. Keep task in progress.
          return 'task-initiated';
        } else {
          const now = new Date().toISOString();
          const inferencePayload = {
            cardId,
            taskName: input.nodeId,
            completionRule,
            context: {
              requires,
              sourcesData,
              computed_values: computeNode.computed_values ?? {},
              provides: data,
              card_data: computeNode.card_data ?? {},
            },
          };

          // Gate inference dispatch using queueRequestedAt — same pattern as source fetches.
          // On a fresh card-handler dispatch update queueRequestedAt; if in-flight just wait.
          if (runQueuedAt) {
            inferenceEntry.queueRequestedAt = runQueuedAt;
            runtimeDirty = true;
          }
          const inferenceQrt = inferenceEntry.queueRequestedAt ?? inferenceEntry.lastRequestedAt ?? now;
          const inferenceAction = decideSourceAction(inferenceEntry, inferenceQrt);

          if (inferenceAction === 'in-flight') {
            // Fetch in-flight; queueRequestedAt already updated — wait for completion.
            runtime._inferenceEntry = inferenceEntry;
            if (runtimeDirty) writeRuntimeState(boardDir, cardId, runtime);
            return 'task-initiated';
          }

          if (inferenceAction === 'idle') {
            // Already fetched for this run.
            return 'task-initiated';
          }

          // dispatch — proceed with invocation
          const inferenceInFile = path.join(os.tmpdir(), `card-inference-${cardId}-${Date.now()}.json`);
          fs.writeFileSync(inferenceInFile, JSON.stringify(inferencePayload, null, 2), 'utf-8');
          appendInferenceAdapterLog(boardDir, cardId, inferencePayload);

          markRequested(inferenceEntry, now);
          runtime._inferenceEntry = inferenceEntry;
          runtimeDirty = true;

          invokeRunInference(boardDir, cardId, inferenceInFile, input.callbackToken, undefined, (err) => {
            if (err) {
              console.error(`[card-handler] ${input.nodeId}:`, err.message);
              const failedAt = new Date().toISOString();
              appendEventToJournal(boardDir, {
                type: 'task-failed',
                taskName: input.nodeId,
                error: err.message,
                timestamp: failedAt,
              });
            }
          });
          return 'task-initiated';
        }
      }

      // Persist task-completed token objects for SSE/runtime consumers.
      writeRuntimeDataObjects(boardDir, data);

      // Spawn undelivered non-gating source_defs in background.
        const undeliveredOptional = allSources.filter(s => {
          if (s.optionalForCompletionGating !== true) return false;
          const entry = runtime._sources[s.outputFile];
          if (!entry?.lastRequestedAt) return true;
          if (!entry.lastFetchedAt) return true;
          return entry.lastFetchedAt <= entry.lastRequestedAt;
        });
      if (undeliveredOptional.length > 0) {
        invokeRunSources(boardDir, cardPath, input.callbackToken, (err) => {
          if (err) console.error(`[card-handler] ${input.nodeId}:`, err.message);
        });
      }

      appendEventToJournal(boardDir, {
        type: 'task-completed',
        taskName: input.nodeId,
        data,
        timestamp: new Date().toISOString(),
      });
      return 'task-initiated';
    },
  };

  const rg = createReactiveGraph(live, { handlers });
  return { rg, journal };
}

// ============================================================================
// CLI
// ============================================================================

/**
 * Helper function to add a single card from file.
 * Throws errors instead of calling process.exit() so it can be used in tests.
 */
function resolveCardGlobMatches(cardGlob: string): string[] {
  const patterns = cardGlob
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => p.replace(/\\/g, '/'));
  const matches = fg.sync(patterns, {
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: false,
  });
  // fast-glob returns forward-slash paths; normalise to native so comparisons
  // against inventory entries (which use path.resolve → backslash on Windows) match.
  return [...matches].map(m => path.resolve(m)).sort((a, b) => a.localeCompare(b));
}

function buildBoardStatusObject(dir: string, live: LiveGraph): BoardStatusObject {
  const taskState = live.state.tasks;
  const taskConfig = live.config.tasks;
  const cardNames = Object.keys(taskState);
  const sched = schedule(live);

  const statusCounts = {
    completed: 0,
    failed: 0,
    in_progress: 0,
    pending: 0,
    blocked: 0,
    unresolved: 0,
  };

  const waitingByCard = new Map<string, string[]>();
  for (const p of sched.pending) waitingByCard.set(p.taskName, p.waitingOn);
  for (const u of sched.unresolved) waitingByCard.set(u.taskName, u.missingTokens);
  for (const b of sched.blocked) waitingByCard.set(b.taskName, b.failedTokens);

  const dependentsByToken = new Map<string, string[]>();
  for (const [name, cfg] of Object.entries(taskConfig)) {
    for (const token of cfg.requires ?? []) {
      const dependents = dependentsByToken.get(token) ?? [];
      dependents.push(name);
      dependentsByToken.set(token, dependents);
    }
  }

  const cards: BoardStatusCard[] = cardNames.sort().map((name) => {
    const state = taskState[name] as {
      status: string;
      data?: Record<string, unknown>;
      error?: string;
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      lastUpdated?: string;
      executionCount?: number;
      retryCount?: number;
    };
    const cfg = taskConfig[name] ?? { requires: [], provides: [] };

    if (state.status === 'completed') statusCounts.completed += 1;
    else if (state.status === 'failed') statusCounts.failed += 1;
    else if (state.status === 'in-progress') statusCounts.in_progress += 1;

    const requires = cfg.requires ?? [];
    const provides = cfg.provides ?? [];
    const runtimeKeys = Object.keys(state.data ?? {}).sort();
    const requiresSatisfied = requires.filter((token) => live.state.availableOutputs.includes(token));
    const requiresMissing = requires.filter((token) => !live.state.availableOutputs.includes(token));
    const blockedBy = waitingByCard.get(name) ?? requiresMissing;

    const unblocks = new Set<string>();
    for (const token of provides) {
      for (const dependent of dependentsByToken.get(token) ?? []) {
        if (dependent !== name) unblocks.add(dependent);
      }
    }

    const lastFailureAt = state.failedAt;
    const error = state.error
      ? {
          message: state.error,
          code: 'TASK_FAILED',
          at: lastFailureAt,
          source: 'task-runtime' as const,
        }
      : undefined;

    return {
      name,
      status: state.status,
      error,
      requires,
      requires_satisfied: requiresSatisfied,
      requires_missing: requiresMissing,
      provides_declared: provides,
      provides_runtime: runtimeKeys,
      blocked_by: blockedBy,
      unblocks: Array.from(unblocks).sort(),
      runtime: {
        attempt_count: state.executionCount ?? 0,
        restart_count: state.retryCount ?? 0,
        in_progress_since: state.status === 'in-progress' ? (state.startedAt ?? null) : null,
        last_transition_at: state.lastUpdated ?? null,
        last_completed_at: state.completedAt ?? null,
        last_restarted_at: state.startedAt ?? null,
        status_age_ms: state.lastUpdated ? Math.max(0, Date.now() - Date.parse(state.lastUpdated)) : null,
      },
    };
  });

  statusCounts.pending = sched.pending.length;
  statusCounts.blocked = sched.blocked.length;
  statusCounts.unresolved = sched.unresolved.length;

  const fanOut = cards
    .map((c) => ({ name: c.name, fanOut: c.unblocks.length }))
    .sort((a, b) => b.fanOut - a.fanOut || a.name.localeCompare(b.name));
  const maxFanOut = fanOut.length > 0 ? fanOut[0] : { name: null, fanOut: 0 };

  const allRequires = new Set<string>();
  for (const cfg of Object.values(taskConfig)) {
    for (const r of cfg.requires ?? []) allRequires.add(r);
  }
  let orphanCards = 0;
  for (const [name, cfg] of Object.entries(taskConfig)) {
    const requiresNone = (cfg.requires ?? []).length === 0;
    const provides = cfg.provides ?? [];
    const feedsAny = provides.some((p) => (dependentsByToken.get(p) ?? []).some((d) => d !== name));
    if (requiresNone && !feedsAny) orphanCards += 1;
  }

  return {
    schema_version: 'v1',
    meta: {
      board: {
        path: path.resolve(dir),
      },
    },
    summary: {
      card_count: cardNames.length,
      completed: statusCounts.completed,
      eligible: sched.eligible.length,
      pending: statusCounts.pending,
      blocked: statusCounts.blocked,
      unresolved: statusCounts.unresolved,
      failed: statusCounts.failed,
      in_progress: statusCounts.in_progress,
      orphan_cards: orphanCards,
      topology: {
        edge_count: Array.from(allRequires).length,
        max_fan_out_card: maxFanOut.name,
        max_fan_out: maxFanOut.fanOut,
      },
    },
    cards,
  };
}

export interface BoardStatusCard {
  name: string;
  status: string;
  error?: {
    message: string;
    code?: string;
    at?: string;
    source?: 'task-runtime' | 'source-fetch' | 'timeout' | 'unknown';
  };
  requires: string[];
  requires_satisfied: string[];
  requires_missing: string[];
  provides_declared: string[];
  provides_runtime: string[];
  blocked_by: string[];
  unblocks: string[];
  runtime: {
    attempt_count: number;
    restart_count: number;
    in_progress_since: string | null;
    last_transition_at: string | null;
    last_completed_at: string | null;
    last_restarted_at: string | null;
    status_age_ms: number | null;
  };
}

export interface BoardStatusObject {
  schema_version: 'v1';
  meta: {
    board: {
      path: string;
    };
  };
  summary: {
    card_count: number;
    completed: number;
    eligible: number;
    pending: number;
    blocked: number;
    unresolved: number;
    failed?: number;
    in_progress?: number;
    orphan_cards?: number;
    topology?: {
      edge_count: number;
      max_fan_out_card: string | null;
      max_fan_out: number;
    };
  };
  cards: BoardStatusCard[];
}

function cmdRunSources(args: string[]): void {
  const cardIdx = args.indexOf('--card');
  const tokenIdx = args.indexOf('--token');
  const rgIdx = args.indexOf('--rg');
  const sourceChecksumsIdx = args.indexOf('--source-checksums');
  const cardFilePath = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
  const callbackToken = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
  const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  const sourceChecksumsJson = sourceChecksumsIdx !== -1 ? args[sourceChecksumsIdx + 1] : undefined;
  const sourceChecksums = sourceChecksumsJson ? JSON.parse(sourceChecksumsJson) as Record<string, string> : undefined;
  if (!cardFilePath || !callbackToken || !boardDir) {
    console.error('Usage: board-live-cards run-sourcedefs-internal --card <path> --token <token> --rg <dir> [--source-checksums <json>]');
    process.exit(1);
  }

  const card = JSON.parse(fs.readFileSync(cardFilePath, 'utf-8'));
  if (path.basename(cardFilePath).startsWith('card-enriched-')) {
    try { fs.unlinkSync(cardFilePath); } catch { /* best-effort */ }
  }
  console.log(`[run-sourcedefs-internal] Processing card "${card.id as string}"`);

  // Load registered task-executor (if any)
  const teConfig = readTaskExecutorConfig(boardDir!);
  const taskExecutor = teConfig?.command;
  const taskExecutorExtraB64 = teConfig?.extra
    ? Buffer.from(JSON.stringify(teConfig.extra)).toString('base64')
    : undefined;

  type SourceDef = {
    cli?: string;
    bindTo: string;
    outputFile?: string;
    optionalForCompletionGating?: boolean;
    timeout?: number;
    cwd?: string;
    boardDir?: string;
  };

  function runSource(src: SourceDef): void {
    const sourceChecksumForInvoke = src.outputFile ? sourceChecksums?.[src.outputFile] : undefined;
    const sourceToken = encodeSourceToken({
      cbk: callbackToken!,
      rg: boardDir!,
      cid: card.id as string,
      b: src.bindTo,
      d: src.outputFile ?? '',
      cs: sourceChecksumForInvoke,
    });

    function reportFailure(reason: string): void {
      invokeSourceDataFetchFailure(sourceToken, reason, (err) => {
        if (err) console.error(`[run-sourcedefs-internal] source-data-fetch-failure call failed:`, err.message);
      });
    }

    function reportFetched(outFile: string): void {
      invokeSourceDataFetched(sourceToken, outFile, () => {
        // logging already done in helper
      });
    }

    if (taskExecutor) {
      // External task-executor registered: invoke run-source-fetch subcommand
      if (!src.outputFile) {
        console.warn(`[run-sourcedefs-internal] source "${src.bindTo}" has no outputFile configured — cannot deliver`);
        reportFailure('no outputFile configured');
        return;
      }
      const inFile  = path.join(os.tmpdir(), `card-source-in-${src.bindTo}-${Date.now()}.json`);
      const outFile = path.join(os.tmpdir(), `card-source-out-${src.bindTo}-${Date.now()}.json`);
      const errFile = path.join(os.tmpdir(), `card-source-err-${src.bindTo}-${Date.now()}.txt`);
      const sourceForExecutor = {
        ...src,
        cwd: typeof src.cwd === 'string' && src.cwd ? src.cwd : path.dirname(cardFilePath || ''),
        boardDir: typeof src.boardDir === 'string' && src.boardDir ? src.boardDir : boardDir,
      };
      appendTaskExecutorLog(boardDir!, sourceForExecutor, 'external-task-executor');
      fs.writeFileSync(inFile, JSON.stringify(sourceForExecutor, null, 2), 'utf-8');
      const executorArgs = ['run-source-fetch', '--in', inFile, '--out', outFile, '--err', errFile];
      if (taskExecutorExtraB64) executorArgs.push('--extra', taskExecutorExtraB64);
      console.log(`[run-sourcedefs-internal] task-executor: ${taskExecutor} ${executorArgs.join(' ')}`);
      try {
        execCommandSync(taskExecutor, executorArgs, {
          shell: true,
          timeout: src.timeout ?? 120_000,
        });
      } catch (err: unknown) {
        const reason = (err as Error).message ?? String(err);
        console.error(`[run-sourcedefs-internal] task-executor failed for source "${src.bindTo}":`, reason);
        reportFailure(reason);
        return;
      }
      if (fs.existsSync(outFile)) {
        reportFetched(outFile);
      } else {
        const errMsg = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : 'executor produced no output file';
        console.warn(`[run-sourcedefs-internal] source "${src.bindTo}": ${errMsg}`);
        reportFailure(errMsg);
      }
      return;
    }

    // No external executor: execute source.cli directly in this process.
    if (!src.outputFile) {
      console.warn(`[run-sourcedefs-internal] source "${src.bindTo}" has no outputFile configured — cannot deliver`);
      reportFailure('no outputFile configured');
      return;
    }
    const outFile = path.join(os.tmpdir(), `card-source-out-${src.bindTo}-${Date.now()}.json`);
    if (!src.cli) {
      const errMsg = 'source.cli is required for built-in source execution';
      console.warn(`[run-sourcedefs-internal] source "${src.bindTo}": ${errMsg}`);
      reportFailure(errMsg);
      return;
    }

    const timeout = src.timeout ?? 120_000;
    const sourceCwd = typeof src.cwd === 'string' ? src.cwd : path.dirname(cardFilePath || '');
    const sourceBoardDir = typeof src.boardDir === 'string' ? src.boardDir : boardDir;
    const sourceForBuiltInExecutor = {
      ...src,
      cwd: sourceCwd,
      boardDir: sourceBoardDir,
    };
    appendTaskExecutorLog(boardDir!, sourceForBuiltInExecutor, 'built-in-run-source-fetch');
    const cmdParts = splitCommandLine(src.cli);
    if (cmdParts.length === 0) {
      const errMsg = 'source.cli command is empty';
      console.warn(`[run-sourcedefs-internal] source "${src.bindTo}": ${errMsg}`);
      reportFailure(errMsg);
      return;
    }

    const rawCmd = cmdParts[0];
    const { cmd, args: cliArgs } = resolveCommandInvocation(rawCmd, cmdParts.slice(1));

    let stdout: string;
    try {
      stdout = execCommandSync(cmd, cliArgs, {
        shell: false,
        encoding: 'utf-8',
        timeout,
        cwd: sourceCwd,
        env: {
          ...process.env,
          ...(sourceBoardDir ? { BOARD_DIR: sourceBoardDir } : {}),
        },
      });
    } catch (err: unknown) {
      const reason = (err as Error).message ?? String(err);
      console.error(`[run-sourcedefs-internal] source fetch failed for source "${src.bindTo}":`, reason);
      reportFailure(reason);
      return;
    }

    fs.writeFileSync(outFile, stdout.trim(), 'utf-8');
    reportFetched(outFile);
  }

  const source_defs = (card.source_defs ?? []) as SourceDef[];
  for (const src of source_defs) {
    runSource(src);
  }
}

function cmdRunInference(args: string[]): void {
  const inIdx = args.indexOf('--in');
  const tokenIdx = args.indexOf('--token');
  const inFile = inIdx !== -1 ? args[inIdx + 1] : undefined;
  const inferenceToken = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;

  if (!inFile || !inferenceToken) {
    console.error('Usage: board-live-cards run-inference-internal --in <input.json> --token <inference-token>');
    process.exit(1);
  }

  // Decode inference token (encoded via encodeSourceToken: cbk, rg, cid, b='', d='', cs)
  const decodedToken = decodeSourceToken(inferenceToken);
  if (!decodedToken) {
    console.error('Invalid inference token');
    process.exit(1);
  }
  const callbackToken = decodedToken.cbk;
  const boardDir = decodedToken.rg;

  const cbkDecoded = decodeCallbackToken(callbackToken);
  if (!cbkDecoded) {
    console.error('Invalid callback token embedded in inference token');
    process.exit(1);
  }

  function spawnInferenceDone(tmpFile: string): void {
    const { cmd, args: cliArgs } = getCliInvocation('inference-done', ['--tmp', tmpFile, '--token', inferenceToken!]);
    spawnDetachedCommand(cmd, cliArgs);
  }

  function spawnInferenceDoneError(reason: string): void {
    const tmpFile = path.join(os.tmpdir(), `card-inference-err-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ isTaskCompleted: false, reason }), 'utf-8');
    spawnInferenceDone(tmpFile);
  }

  if (!fs.existsSync(inFile)) {
    spawnInferenceDoneError(`inference input not found: ${inFile}`);
    return;
  }

  const adapterFile = path.join(boardDir, INFERENCE_ADAPTER_FILE);
  const inferenceAdapter = fs.existsSync(adapterFile) ? fs.readFileSync(adapterFile, 'utf-8').trim() : undefined;
  if (!inferenceAdapter) {
    spawnInferenceDoneError(`inference adapter is not configured (${INFERENCE_ADAPTER_FILE})`);
    return;
  }

  const outFile = path.join(os.tmpdir(), `card-inference-out-${Date.now()}.json`);
  const errFile = path.join(os.tmpdir(), `card-inference-err-${Date.now()}.txt`);
  const adapterParts = splitCommandLine(inferenceAdapter);
  if (adapterParts.length === 0) {
    spawnInferenceDoneError('inference adapter command is empty');
    return;
  }

  const adapterRawCmd = adapterParts[0];
  const adapterRawArgs = adapterParts.slice(1);
  const { cmd: adapterCmd, args: adapterArgsPrefix } = resolveCommandInvocation(adapterRawCmd, adapterRawArgs);
  const adapterArgs = [...adapterArgsPrefix, 'run-inference', '--in', inFile, '--out', outFile, '--err', errFile];

  try {
    execCommandSync(adapterCmd, adapterArgs, {
      shell: false,
      timeout: 120_000,
      cwd: boardDir,
      env: {
        ...process.env,
        BOARD_DIR: boardDir,
      },
    });
  } catch (err: unknown) {
    const reason = (err as Error).message ?? String(err);
    spawnInferenceDoneError(reason);
    return;
  }

  if (!fs.existsSync(outFile)) {
    const errMsg = fs.existsSync(errFile)
      ? fs.readFileSync(errFile, 'utf-8').trim()
      : 'inference adapter produced no output file';
    spawnInferenceDoneError(errMsg);
    return;
  }

  // Adapter wrote outFile — pass it directly as --tmp; cmdInferenceDone reads and deletes it.
  spawnInferenceDone(outFile);
}

function cmdInferenceDone(args: string[]): void {
  const tmpIdx = args.indexOf('--tmp');
  const tokenIdx = args.indexOf('--token');

  const tmpFile = tmpIdx !== -1 ? args[tmpIdx + 1] : undefined;
  const inferenceToken = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;

  if (!tmpFile || !inferenceToken) {
    console.error('Usage: board-live-cards inference-done --tmp <result.json> --token <inference-token>');
    process.exit(1);
  }

  const decodedToken = decodeSourceToken(inferenceToken);
  if (!decodedToken) {
    console.error('Invalid inference token');
    process.exit(1);
  }

  const { cbk: callbackToken, rg: dir, cs: inputChecksum } = decodedToken;

  const decoded = decodeCallbackToken(callbackToken);
  if (!decoded) {
    console.error('Invalid callback token embedded in inference token');
    process.exit(1);
  }

  const taskName = decoded.taskName;
  const cardPath = lookupCardPath(dir, taskName);
  if (!cardPath) {
    console.error(`Card file for task "${taskName}" not found in inventory`);
    process.exit(1);
  }

  let result: { isTaskCompleted?: boolean; reason?: string; evidence?: string; data?: Record<string, unknown> } = {};
  if (fs.existsSync(tmpFile)) {
    try {
      result = JSON.parse(fs.readFileSync(tmpFile, 'utf-8').trim());
    } catch (err) {
      result = { isTaskCompleted: false, reason: `failed to parse inference result: ${err instanceof Error ? err.message : String(err)}` };
    }
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
  } else {
    result = { isTaskCompleted: false, reason: `inference result file not found: ${tmpFile}` };
  }

  const isTaskCompletedFlag = result.isTaskCompleted === true;
  const inferenceCompletedAt = new Date().toISOString();

  const card = JSON.parse(fs.readFileSync(cardPath, 'utf-8')) as Record<string, unknown>;
  if (!card.card_data) card.card_data = {};
  const cardData = card.card_data as Record<string, unknown>;
  const existingInference = (cardData.llm_task_completion_inference && typeof cardData.llm_task_completion_inference === 'object')
    ? (cardData.llm_task_completion_inference as Record<string, unknown>)
    : {};
  cardData.llm_task_completion_inference = {
    ...existingInference,
    isTaskCompleted: isTaskCompletedFlag,
    reason: typeof result.reason === 'string' ? result.reason : '',
    evidence: typeof result.evidence === 'string' ? result.evidence : '',
    inferenceCompletedAt,
  };
  fs.writeFileSync(cardPath, JSON.stringify(card, null, 2), 'utf-8');

  // Update inference runtime entry to reflect completion
  const runtimePath = path.join(dir, taskName, 'runtime.json');
  let runtime: CardRuntimeState = { _sources: {} };
  if (fs.existsSync(runtimePath)) {
    try {
      runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8')) as CardRuntimeState;
    } catch {}
  }

  const inferenceEntry = runtime._inferenceEntry ?? {};
  runtime._inferenceEntry = nextEntryAfterFetchDelivery(inferenceEntry, inferenceCompletedAt);

  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2), 'utf-8');

  appendEventToJournal(dir, {
    type: 'task-progress',
    taskName,
    update: {
      kind: 'inference-done',
      isTaskCompleted: isTaskCompletedFlag,
      inputChecksum,
    },
    timestamp: inferenceCompletedAt,
  });

  void processAccumulatedEventsInfinitePass(dir);
}



/**
 * Run-source-fetch protocol: execute a source definition.
 * Board-live-cards built-in implementation understands source.cli field.
 *
 * Reads source definition from --in, executes its cli field,
 * writes result to --out file. Presence of --out indicates success.
 */
function cmdUpsertCard(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const cardIdx = args.indexOf('--card');
  const globIdx = args.indexOf('--card-glob');
  const cardIdIdx = args.indexOf('--card-id');
  const restart = args.includes('--restart');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  const cardFile = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
  const cardGlob = globIdx !== -1 ? args[globIdx + 1] : undefined;
  const requestedCardId = cardIdIdx !== -1 ? args[cardIdIdx + 1] : undefined;

  if (!dir || (!cardFile && !cardGlob) || (cardFile && cardGlob)) {
    console.error('Usage: board-live-cards upsert-card --rg <dir> (--card <card.json> | --card-glob <glob>) [--card-id <card-id>] [--restart]');
    process.exit(1);
  }

  if (cardGlob && requestedCardId) {
    console.error('Usage: --card-id may be used only with --card (single file), not with --card-glob');
    process.exit(1);
  }

  const cardFiles = cardFile
    ? [path.resolve(cardFile)]
    : resolveCardGlobMatches(cardGlob!);

  if (!cardFile && cardFiles.length === 0) {
    console.error(`No card files matched glob: ${cardGlob}`);
    process.exit(1);
  }

  const idx = buildCardInventoryIndex(dir);
  const batchByCardId = new Map<string, string>();
  const batchByCardPath = new Map<string, string>();
  const plans: Array<{
    card: BoardLiveCard;
    absCardPath: string;
    isInsert: boolean;
  }> = [];
  const logs: string[] = [];

  // Phase 1: pre-validate entire batch (atomicity guard)
  for (const absCardPath of cardFiles) {
    if (!fs.existsSync(absCardPath)) {
      console.error(`Card file not found: ${absCardPath}`);
      process.exit(1);
    }

    const card: BoardLiveCard = JSON.parse(fs.readFileSync(absCardPath, 'utf-8'));
    if (!card.id) {
      console.error(`Card JSON must have an "id" field (${absCardPath})`);
      process.exit(1);
    }

    if (requestedCardId && requestedCardId !== card.id) {
      console.error(
        `Card id mismatch: --card-id "${requestedCardId}" does not match file id "${card.id}" (${absCardPath})`
      );
      process.exit(1);
    }

    const seenPathCardId = batchByCardPath.get(absCardPath);
    if (seenPathCardId && seenPathCardId !== card.id) {
      console.error(
        `Upsert rejected: file "${absCardPath}" appears multiple times in batch with conflicting ids ` +
        `("${seenPathCardId}" vs "${card.id}")`
      );
      process.exit(1);
    }

    const seenCardPath = batchByCardId.get(card.id);
    if (seenCardPath && seenCardPath !== absCardPath) {
      console.error(
        `Upsert rejected: card id "${card.id}" appears multiple times in batch with conflicting files ` +
        `("${seenCardPath}" vs "${absCardPath}")`
      );
      process.exit(1);
    }

    const existingById = idx.byCardId.get(card.id);
    const existingByPath = idx.byCardPath.get(absCardPath);

    // Enforce strict one-to-one mapping between card id and file path.
    if (existingByPath && existingByPath.cardId !== card.id) {
      console.error(
        `Upsert rejected: file "${absCardPath}" is already mapped to card id "${existingByPath.cardId}", ` +
        `cannot remap to "${card.id}"`
      );
      process.exit(1);
    }

    if (existingById && existingById.cardFilePath !== absCardPath) {
      console.error(
        `Upsert rejected: card id "${card.id}" is already mapped to file "${existingById.cardFilePath}", ` +
        `cannot remap to "${absCardPath}"`
      );
      process.exit(1);
    }

    batchByCardPath.set(absCardPath, card.id);
    batchByCardId.set(card.id, absCardPath);

    plans.push({
      card,
      absCardPath,
      isInsert: !existingById,
    });
  }

  // Phase 2: commit writes after full pre-validation succeeds
  for (const plan of plans) {
    const { card, absCardPath, isInsert } = plan;

    if (isInsert) {
      const newEntry: CardInventoryEntry = {
        cardId: card.id,
        cardFilePath: absCardPath,
        addedAt: new Date().toISOString(),
      };
      appendCardInventory(dir, newEntry);
      idx.byCardId.set(card.id, newEntry);
      idx.byCardPath.set(absCardPath, newEntry);
    }

    const taskConfig = liveCardToTaskConfig(card);
    appendEventToJournal(dir, {
      type: 'task-upsert',
      taskName: card.id,
      taskConfig,
      timestamp: new Date().toISOString(),
    });

    if (restart) {
      appendEventToJournal(dir, {
        type: 'task-restart',
        taskName: card.id,
        timestamp: new Date().toISOString(),
      });
    }

    logs.push(`Card "${card.id}" ${isInsert ? 'upserted (inserted)' : 'upserted (updated)'}${restart ? ' (restarted)' : ''}.`);
  }

  void processAccumulatedEventsInfinitePass(dir);
  if (cardGlob) {
    console.log(`Upserted ${cardFiles.length} cards from glob: ${cardGlob}${restart ? ' (restarted)' : ''}`);
  } else {
    console.log(logs[0]);
  }
}

/**
 * process-accumulated-events command.
 *
 * Default mode: performs one immediate pass and schedules relay continuation
 * in a detached worker process.
 *
 * Internal mode (--inline-loop): execute full in-process settle loop.
 * Used only by the detached worker to avoid recursive respawn.
 */
async function cmdTryDrain(args: string[]): Promise<void> {
  const rgIdx = args.indexOf('--rg');
  const inlineLoop = args.includes('--inline-loop');
  const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  if (!boardDir) {
    console.error('Usage: board-live-cards process-accumulated-events --rg <dir>');
    process.exit(1);
  }

  await processAccumulatedEventsForced(boardDir, { inlineLoop });
}

export async function cli(argv: string[]): Promise<void> {
  const boardCommandHandlers = createBoardCommandHandlers({
    initBoard,
    configureRuntimeOutDir,
    loadBoard,
    writeJsonAtomic,
    resolveStatusSnapshotPath,
    buildBoardStatusObject,
    readTaskExecutorConfig,
    resolveCardGlobMatches,
    validateLiveCardDefinition,
    execCommandSync,
    appendEventToJournal,
    processAccumulatedEventsInfinitePass,
  });
  const callbackCommandHandlers = createCallbackCommandHandlers({
    decodeCallbackToken,
    decodeSourceToken,
    writeRuntimeDataObjects,
    appendEventToJournal,
    processAccumulatedEventsForced,
    processAccumulatedEventsInfinitePass,
  });
  const nonCoreCommandHandlers = createNonCoreCommandHandlers({
    readTaskExecutorConfig,
    execCommandSync,
    splitCommandLine,
    resolveCommandInvocation,
  });

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':            return nonCoreCommandHandlers.cmdHelp();
    case 'init':           return boardCommandHandlers.cmdInit(rest);
    case 'status':         return boardCommandHandlers.cmdStatus(rest);
    case 'upsert-card':    return cmdUpsertCard(rest);
    case 'validate-card':  return boardCommandHandlers.cmdValidateCard(rest);
    case 'remove-card':              return boardCommandHandlers.cmdRemoveCard(rest);
    case 'retrigger':                 return boardCommandHandlers.cmdRetrigger(rest);
    case 'task-completed':            return callbackCommandHandlers.cmdTaskCompleted(rest);
    case 'task-failed':               return callbackCommandHandlers.cmdTaskFailed(rest);
    case 'task-progress':             return callbackCommandHandlers.cmdTaskProgress(rest);
    case 'source-data-fetched':       return callbackCommandHandlers.cmdSourceDataFetched(rest);
    case 'source-data-fetch-failure': return callbackCommandHandlers.cmdSourceDataFetchFailure(rest);
    case 'run-sourcedefs-internal':      return cmdRunSources(rest);
    case 'run-inference-internal':    return cmdRunInference(rest);
    case 'inference-done':            return cmdInferenceDone(rest);
    case 'run-source-fetch':          return nonCoreCommandHandlers.cmdRunSourceFetch(rest);
    case 'probe-source':               return await nonCoreCommandHandlers.cmdProbeSource(rest);
    case 'describe-task-executor-capabilities': return nonCoreCommandHandlers.cmdDescribeTaskExecutorCapabilities(rest);
    case 'process-accumulated-events': return await cmdTryDrain(rest);
    default:
      throw new Error(`Unknown command: ${cmd ?? '(none)'}`);
  }
}

// Run when invoked directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
