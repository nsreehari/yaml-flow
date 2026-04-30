/**
 * process-runner.ts — Single source of truth for child process execution.
 *
 * All CLI execution paths (task-executor, source.cli, inference-adapter,
 * detached background workers) route through these helpers.
 *
 * DESIGN:
 *   - CommandSpec is the structured command form: { command, args, cwd, env, timeoutMs }
 *   - runSync / runAsync use execFileSync / execFile (no ambient shell)
 *   - runDetached handles OS differences in one place
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
import { execFileSync, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CommandSpec } from '../continuous-event-graph/handlers.js';
import type { InvocationAdapter, DispatchResult } from './board-live-cards-lib-types.js';

export type { CommandSpec };

// ============================================================================
// makeBoardTempFilePath — board-scoped temp file path for external process handoff
// ============================================================================

/**
 * Return a unique file path under `<boardDir>/.tmp/` suitable for passing
 * to an external binary (task-executor, inference-adapter) as `--in`, `--out`,
 * or `--err` arguments.
 *
 * - Files are co-located with the board they belong to (not global os.tmpdir()).
 * - The `.tmp/` directory is created on demand.
 * - The file itself is NOT created here — the caller writes it before use.
 * - `ext` defaults to `.json`; use `.txt` for plain-text error files.
 */
export function makeBoardTempFilePath(boardDir: string, label: string, ext = '.json'): string {
  const tmpDir = path.join(boardDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  return path.join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}

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
export function runSync(spec: CommandSpec, options?: { encoding?: BufferEncoding }): string {
  const { command, args = [], cwd, env, timeoutMs } = spec;
  const output = execFileSync(command, args, {
    shell: _needsWindowsShell(command),
    timeout: timeoutMs,
    encoding: options?.encoding ?? 'utf-8',
    cwd,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
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

// ============================================================================
// Git Bash detection (Windows only — needed for runDetached)
// ============================================================================

let _gitBashPath: string | false | undefined;
const _GIT_BASH_CACHE = path.join(os.tmpdir(), '.board-live-cards-git-bash-cache.json');

export function findGitBash(): string | false {
  if (_gitBashPath !== undefined) return _gitBashPath;
  if (process.platform !== 'win32') return (_gitBashPath = false);

  try {
    const cached = JSON.parse(fs.readFileSync(_GIT_BASH_CACHE, 'utf8')) as { path: string | false };
    if (cached.path === false || (typeof cached.path === 'string' && fs.existsSync(cached.path))) {
      return (_gitBashPath = cached.path);
    }
  } catch { /* cache miss */ }

  const candidates: Array<string | undefined> = [
    process.env.SHELL,
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, 'Git', 'usr', 'bin', 'bash.exe')
      : undefined,
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, 'Git', 'bin', 'bash.exe')
      : undefined,
    process.env['PROGRAMFILES(X86)']
      ? path.join(process.env['PROGRAMFILES(X86)']!, 'Git', 'bin', 'bash.exe')
      : undefined,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : undefined,
  ];

  for (const c of candidates) {
    if (c && /bash(\.exe)?$/i.test(c) && fs.existsSync(c)) {
      _gitBashPath = c;
      try { fs.writeFileSync(_GIT_BASH_CACHE, JSON.stringify({ path: c })); } catch { /* best-effort */ }
      return _gitBashPath;
    }
  }

  _gitBashPath = false;
  try { fs.writeFileSync(_GIT_BASH_CACHE, JSON.stringify({ path: false })); } catch { /* best-effort */ }
  return _gitBashPath;
}

function _shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ============================================================================
// runDetached — fire-and-forget background spawn
// ============================================================================

/**
 * Spawn a detached background process that survives parent exit.
 * Handles Windows (Git Bash / cmd /c start /b) and Linux/macOS transparently.
 */
export function runDetached(spec: CommandSpec): void {
  const { command, args = [] } = spec;

  if (process.platform === 'win32') {
    const bash = findGitBash();
    if (bash) {
      const shellCmd = [command, ...args]
        .map(a => _shellQuote(a.replace(/\\/g, '/')))
        .join(' ');
      const child = spawn(bash, ['-c', shellCmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return;
    }
    const child = spawn('cmd', ['/c', 'start', '/b', '', command, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

// ============================================================================
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
  const tsxMjs = path.join(cliDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const tsxBin = path.join(cliDir, '..', '..', 'node_modules', '.bin', 'tsx');
  const tsx = fs.existsSync(tsxMjs) ? tsxMjs : tsxBin;
  if (fs.existsSync(tsPath) && fs.existsSync(tsx)) {
    return { cmd: process.execPath, args: [tsx, tsPath, command, ...args] };
  }

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { cmd: npxCmd, args: ['tsx', tsPath, command, ...args] };
}

// ============================================================================
// createNodeInvocationAdapter — spawns board CLI sub-processes for source-fetch
// and inference requests. Owns temp file creation for subprocess handoff.
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
    if (shouldSuppressSpawn()) return { dispatched: false, invocationId: undefined };
    try {
      const cardId = (enrichedCard.id as string | undefined) ?? 'unknown';
      const enrichedCardPath = makeBoardTempFilePath(boardDir, `card-enriched-${cardId}`);
      fs.writeFileSync(enrichedCardPath, JSON.stringify(enrichedCard, null, 2), 'utf-8');
      const args = ['--card', enrichedCardPath, '--token', callbackToken, '--rg', boardDir];
      const { cmd, args: cmdArgs } = buildBoardCliInvocation(this.cliDir, 'run-sourcedefs-internal', args);
      runDetached({ command: cmd, args: cmdArgs });
      return { dispatched: true, invocationId: randomUUID() };
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
    if (shouldSuppressSpawn()) return { dispatched: false, invocationId: undefined };
    try {
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
      runDetached({ command: cmd, args });
      return { dispatched: true, invocationId: randomUUID() };
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
