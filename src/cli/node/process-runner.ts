/**
 * process-runner.ts — Single source of truth for child process execution.
 *
 * All CLI execution paths (task-executor, source.cli, inference-adapter)
 * route through these helpers.
 *
 * DESIGN:
 *   - CommandSpec is the structured command form: { command, args, cwd, env, timeoutMs }
 *   - runSync / runAsync use execFileSync / execFile (no ambient shell)
 *   - parseCommandSpec reads both legacy string form and new { command, args } form
 *
 * WHY NO SHELL BY DEFAULT:
 *   - Shell interpretation is platform-dependent (cmd.exe vs /bin/sh vs bash)
 *   - Shell parsing of argument strings is fragile and platform-fragile
 *   - execFile / execFileSync avoids all quoting and escaping issues
 *
 * BACKWARD COMPAT:
 *   - parseCommandSpec("node my-tool.js --flag") → { command: process.execPath, args: ['my-tool.js', '--flag'] }
 *   - Legacy .task-executor / .inference-adapter / source.cli string values still load correctly
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

import type { CommandSpec } from '../../continuous-event-graph/handlers.js';
export type { CommandSpec };

/** Join path segments — thin wrapper so callers don't need to import node:path. */
export function joinPath(...segments: string[]): string { return path.join(...segments); }

/** Resolve a path to absolute — thin wrapper so callers don't need to import node:path. */
export function resolvePath(...segments: string[]): string { return path.resolve(...segments); }

/** Return true if the path is absolute. */
export function isAbsolutePath(p: string): boolean { return path.isAbsolute(p); }

/** Generate a new random UUID. */
export function genUUID(): string { return randomUUID(); }

/** SHA-256 hex hash of a string. */
export function getHash(x: string): string { return createHash('sha256').update(x).digest('hex'); }

/** Resolve the directory of an ESM module from its import.meta.url. */
export function resolveModuleDir(importMetaUrl: string): string { return path.dirname(fileURLToPath(importMetaUrl)); }

// ============================================================================
// parseCommandSpec — legacy string or structured CommandSpec → normalized form
// ============================================================================

/**
 * Parse a legacy string command or pass through a structured CommandSpec.
 *
 * - Legacy string:  "node script.js --flag value"
 *   → { command: process.execPath, args: ['script.js', '--flag', 'value'] }
 *
 * - Structured:  { command: 'node', args: ['script.js', '--flag', 'value'] }
 *   → { command: process.execPath, args: ['script.js', '--flag', 'value'] }
 *
 * After parsing, 'node'/'node.exe' is resolved to process.execPath, and bare
 * '.js'/'.mjs' paths are wrapped in a node invocation.
 */
export function parseCommandSpec(raw: string | CommandSpec): CommandSpec {
  if (typeof raw === 'object' && raw !== null) {
    const { command, args = [], ...rest } = raw;
    const resolved = _resolveNode(command, args);
    return { ...rest, command: resolved.command, args: resolved.args };
  }
  const parts = splitCommandLine(raw);
  if (parts.length === 0) throw new Error(`Empty command spec: ${JSON.stringify(raw)}`);
  return _resolveNode(parts[0], parts.slice(1));
}

function _resolveNode(cmd: string, args: string[]): { command: string; args: string[] } {
  if (/^(node|node\.exe)$/i.test(cmd)) return { command: process.execPath, args };
  if (/\.m?js$/i.test(cmd)) return { command: process.execPath, args: [cmd, ...args] };
  return { command: cmd, args };
}

// ============================================================================
// splitCommandLine — shell-style string splitting (legacy compat only)
// ============================================================================

/**
 * Split a shell-style command string into tokens, respecting single/double quotes.
 * Used only for backward-compat parsing of legacy string-format config values.
 */
export function splitCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;

  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) { quote = null; } else { current += ch; }
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }

  if (quote) throw new Error(`Unterminated quote in command: ${command}`);
  if (current) tokens.push(current);
  return tokens;
}

// ============================================================================
// .cmd/.bat on Windows needs shell: true
// ============================================================================

function _needsWindowsShell(cmd: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
}

// ============================================================================
// runSync — synchronous process execution
// ============================================================================

/**
 * Run a command synchronously and return stdout as a string.
 * Uses execFileSync — no ambient shell. Safe on all platforms.
 */
export function runSync(spec: CommandSpec, options?: { encoding?: BufferEncoding; input?: string }): string {
  const { command, args = [], cwd, env, timeoutMs } = spec;
  const output = execFileSync(command, args, {
    shell: _needsWindowsShell(command),
    timeout: timeoutMs,
    encoding: options?.encoding ?? 'utf-8',
    cwd,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
    input: options?.input,
  });
  return output as string;
}

// ============================================================================
// runAsync — async process execution with callback
// ============================================================================

/**
 * Run a command asynchronously, calling back with (err, stdout, stderr).
 * Uses execFile — no ambient shell. Safe on all platforms.
 */
export function runAsync(
  spec: CommandSpec,
  callback: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  const { command, args = [], cwd, env, timeoutMs = 30_000 } = spec;
  execFile(
    command,
    args,
    {
      shell: _needsWindowsShell(command),
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
    },
    (err, stdout, stderr) => callback(err ?? null, stdout, stderr),
  );
}

// buildBoardCliInvocation — resolve how to invoke board-live-cards-cli
//
// cliDir is the directory containing board-live-cards-cli.ts / .js.
// Probe order: compiled .js → tsx dev → npx tsx fallback.
// ============================================================================

/**
 * Return { cmd, args } that invokes `board-live-cards-cli <command> [...args]`
 * in whatever environment is available (compiled dist, dev tsx, npx fallback).
 *
 * Pass `__dirname` (from the calling file's own directory) as `cliDir`.
 */
export function buildBoardCliInvocation(
  cliDir: string,
  command: string,
  args: string[],
): { cmd: string; args: string[] } {
  const jsPath = path.join(cliDir, 'board-live-cards-cli.js');
  if (fs.existsSync(jsPath)) {
    return { cmd: process.execPath, args: [jsPath, command, ...args] };
  }

  const tsPath = path.join(cliDir, 'board-live-cards-cli.ts');
  const tsxCandidates = [
    path.join(cliDir, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(cliDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(cliDir, '..', '..', '..', 'node_modules', '.bin', 'tsx'),
    path.join(cliDir, '..', '..', 'node_modules', '.bin', 'tsx'),
  ];
  const tsx = tsxCandidates.find(candidate => fs.existsSync(candidate));
  if (fs.existsSync(tsPath) && tsx) {
    return { cmd: process.execPath, args: [tsx, tsPath, command, ...args] };
  }

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { cmd: npxCmd, args: ['tsx', tsPath, command, ...args] };
}

/**
 * Resolve a stable script path for callback-style invocations where the callee
 * only accepts `node <script> ...` (no separate runtime args like tsx).
 *
 * Prefer the published bundled artifact when available. Fall back to the repo
 * wrapper for local dev/test modes, then to the compiled JS CLI entrypoint.
 */
export function resolveBoardCliCallbackTarget(cliDir: string): string {
  const mjsPath = path.join(cliDir, 'board-live-cards-cli.mjs');
  if (fs.existsSync(mjsPath)) return mjsPath;

  // 3 levels up: dist/cli/node -> repo root, then into dev/ (compiled mode)
  const repoBoardCliWrapper = path.join(cliDir, '..', '..', '..', 'dev', 'board-live-cards-cli.js');
  if (fs.existsSync(repoBoardCliWrapper)) return repoBoardCliWrapper;

  // 2 levels up: tests/cli -> repo root, then into dev/ (test/source mode)
  const repoBoardCliWrapper2 = path.join(cliDir, '..', '..', 'dev', 'board-live-cards-cli.js');
  if (fs.existsSync(repoBoardCliWrapper2)) return repoBoardCliWrapper2;

  const jsPath = path.join(cliDir, 'board-live-cards-cli.js');
  if (fs.existsSync(jsPath)) return jsPath;

  throw new Error(
    `resolveBoardCliCallbackTarget: cannot find callback target in ${cliDir} ` +
    `(expected dev/board-live-cards-cli.js wrapper, ${jsPath}, or ${mjsPath})`
  );
}

// ============================================================================
// Named-pipe event transport (cross-process board notifications)
// ============================================================================

/** Return canonical named-pipe/socket path for the given channel name. */
export function getNamedPipePath(pipeName: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${pipeName}`;
  return path.join(os.tmpdir(), `${pipeName}.sock`);
}

/**
 * Publish a batch of JSON notifications as newline-delimited records to a named pipe.
 * Best-effort: if the pipe is unavailable, logs via onWarn and drops the batch.
 *
 * All payloads are concatenated into a single `socket.write()` call so the consumer
 * receives them atomically (no interleaving from other drain cycles).
 * Uses a per-pipeName persistent connection so ordering is preserved across calls.
 */
const _pipeClients = new Map<string, { socket: net.Socket; ready: boolean; queue: string[] }>();

export function publishJsonEventsToNamedPipe(
  pipeName: string,
  payloads: unknown[],
  onWarn?: (msg: string) => void,
): void {
  if (payloads.length === 0) return;
  const chunk = payloads.map(p => JSON.stringify(p)).join('\n') + '\n';
  let entry = _pipeClients.get(pipeName);

  if (entry && !entry.socket.destroyed) {
    if (entry.ready) {
      entry.socket.write(chunk);
    } else {
      entry.queue.push(chunk);
    }
    return;
  }

  // Create a new persistent connection
  const pipePath = getNamedPipePath(pipeName);
  const socket = net.createConnection(pipePath);
  entry = { socket, ready: false, queue: [chunk] };
  _pipeClients.set(pipeName, entry);

  socket.on('connect', () => {
    entry!.ready = true;
    for (const queued of entry!.queue) socket.write(queued);
    entry!.queue.length = 0;
  });

  socket.on('error', (e) => {
    onWarn?.(`[named-pipe publish] ${pipePath}: ${e instanceof Error ? e.message : String(e)}`);
    _pipeClients.delete(pipeName);
  });

  socket.on('close', () => {
    _pipeClients.delete(pipeName);
  });
}

// ============================================================================
// createNodeCommandExecutor — Node implementation of CommandExecutor
//
// Wraps runSync / runAsync / parseCommandSpec / splitCommandLine
// into a single injectable object. Pass to command handlers instead of the
// individual execCommandSync / execCommandAsync / resolveCommandInvocation /
// splitCommandLine dep functions.
// ============================================================================

import type { CommandExecutor, ExecOptions } from '../common/process-interface.js';

export function createNodeCommandExecutor(): CommandExecutor {
  return {
    executeSync(cmd: string, args: string[], options?: ExecOptions): string {
      return runSync(
        { command: cmd, args, cwd: options?.cwd, timeoutMs: options?.timeout, env: options?.env as Record<string, string> | undefined },
        { encoding: options?.encoding as BufferEncoding | undefined, input: options?.input },
      );
    },
    executeAsync(cmd: string, args: string[], callback: (err: Error | null, stdout: string, stderr: string) => void): void {
      runAsync({ command: cmd, args }, callback);
    },
    resolveInvocation(rawCmd: string, rawArgs: string[]): { cmd: string; args: string[] } {
      const spec = parseCommandSpec({ command: rawCmd, args: rawArgs });
      return { cmd: spec.command, args: spec.args ?? [] };
    },
    splitCommand: splitCommandLine,
  };
}
