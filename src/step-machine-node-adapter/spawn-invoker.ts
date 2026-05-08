/**
 * step-machine-node-adapter — Node spawn invoker
 *
 * Implements `InvokeFn` for local-node / local-python / local-process
 * execution refs by spawning a child process synchronously.
 *
 * Adapter responsibilities (per the framework/adapter boundary):
 *   1. Resolve the ExecutionRef into (cmd, args, cwd) using flowDir for
 *      relative fs-path resolution.
 *   2. Apply argsMassaging (cmdTemplate / bodyTemplate) against the input
 *      context. urlTemplate is ignored here (HTTP transport only).
 *   3. Spawn the process with the JSON-encoded body on stdin.
 *   4. Map transport outcome (exit code) into `{ result, data, error? }`.
 *      The framework never looks at stdout / stderr directly.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { resolveArgsMassaging } from '../step-machine-public/args-massaging.js';
import type {
  InvokeFn,
  NormalizedHandlerResult,
} from '../step-machine-public/types.js';
import type { ExecutionRef } from '../cli/common/execution-interface.js';

// ============================================================================
// KindRef parsing (e.g. "::fs-path::/abs/path/to/script.js")
// ============================================================================

interface KindRef {
  kind: string;
  value: string;
}

function parseKindRef(whatToRun: string): KindRef {
  const match = /^::([^:]+)::(.+)$/.exec(whatToRun);
  if (!match) {
    throw new Error(
      `[step-machine-node-adapter] Invalid whatToRun KindRef: "${whatToRun}". Expected ::kind::value format.`,
    );
  }
  return { kind: match[1], value: match[2] };
}

// ============================================================================
// Resolve ExecutionRef → (cmd, args, cwd)
// ============================================================================

interface ResolvedCommand {
  cmd: string;
  args: string[];
  cwd: string;
}

function resolveRefCommand(ref: ExecutionRef, flowDir: string): ResolvedCommand {
  const { kind, value } = parseKindRef(ref.whatToRun);

  if (kind !== 'fs-path') {
    throw new Error(
      `[step-machine-node-adapter] Unsupported whatToRun kind "${kind}". Only fs-path is supported for local execution.`,
    );
  }

  const scriptPath = path.isAbsolute(value) ? value : path.resolve(flowDir, value);

  switch (ref.howToRun) {
    case 'local-node':
      return { cmd: process.execPath, args: [scriptPath], cwd: flowDir };
    case 'local-python':
      return { cmd: 'python', args: [scriptPath], cwd: flowDir };
    case 'local-process':
      return { cmd: scriptPath, args: [], cwd: flowDir };
    default:
      throw new Error(
        `[step-machine-node-adapter] Unsupported howToRun "${ref.howToRun}" for fs-path ref.`,
      );
  }
}

// ============================================================================
// Stdout JSON parsing — tolerant of trailing log lines
// ============================================================================

function parseStdoutAsJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('empty stdout');
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    return JSON.parse(last);
  }
}

// ============================================================================
// Factory: create an InvokeFn bound to a flowDir
// ============================================================================

export interface CreateNodeSpawnInvokerOptions {
  /** Directory for resolving relative fs-path refs. */
  flowDir: string;
}

export function createNodeSpawnInvoker(
  options: CreateNodeSpawnInvokerOptions,
): InvokeFn {
  const { flowDir } = options;

  return async (ref, input, context): Promise<NormalizedHandlerResult> => {
    const { stepName } = context;

    let resolved: ResolvedCommand;
    try {
      resolved = resolveRefCommand(ref, flowDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: 'failure',
        data: { error: `[${stepName}] ref resolution failed: ${msg}` },
      };
    }

    let massaged;
    try {
      massaged = resolveArgsMassaging(ref.argsMassaging, input, stepName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: 'failure',
        data: { error: msg },
      };
    }

    const args = [...resolved.args];
    if (massaged.cmdArgs) args.push(...massaged.cmdArgs);

    // bodyTemplate produces stdin; if absent, send full input context.
    const payload = JSON.stringify(massaged.body ?? input);

    const proc = spawnSync(resolved.cmd, args, {
      cwd: resolved.cwd,
      input: payload,
      encoding: 'utf-8',
      windowsHide: true,
    });

    if (proc.error) {
      return {
        result: 'failure',
        data: {
          error: `[${stepName}] ref failed to start: ${proc.error.message}`,
        },
      };
    }

    const stdout = proc.stdout ?? '';
    const stderr = (proc.stderr ?? '').trim();

    if (proc.status !== 0) {
      return {
        result: 'failure',
        data: {
          error: `[${stepName}] ref exited with status ${proc.status}${stderr ? `: ${stderr}` : ''}`,
        },
      };
    }

    // Transport succeeded — payload is whatever the process wrote.
    // Framework never inspects shape; we just normalize to data.
    try {
      const parsed = parseStdoutAsJson(stdout);
      const data: Record<string, unknown> =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { stdout: parsed };
      return { result: 'success', data };
    } catch {
      return { result: 'success', data: { stdout: stdout.trim() } };
    }
  };
}
