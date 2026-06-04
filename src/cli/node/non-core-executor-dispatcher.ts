/**
 * non-core-executor-dispatcher.ts
 *
 * Storage-agnostic Node implementation of `BoardNonCorePlatformAdapter.invokeExecutor`.
 *
 * Lives outside fs-board-adapter and firestore-storage so any host (fs, firestore,
 * cosmos, …) can compose the same dispatcher onto its storage adapter to produce a
 * full `BoardNonCorePlatformAdapter`.
 *
 * Dispatch is a pure switch on `ref.howToRun`:
 *   - http:post / in-process-loop  → invokeBoardWorker(ref, { subcommand, input? })
 *   - http:get                      → invokeExecutionRef(ref, { subcommand, input?, extra? })
 *   - local-node / local-python /
 *     local-process / built-in       → spawn(command, [...baseArgs, subcommand, --extra?])
 *   - queue-storage                  → throws (use opts.resolveRef to rewrite first)
 *
 * `resolveRef` lets callers rewrite a ref before dispatch (e.g. an offline localfs
 * host can rewrite a `queue-storage` hosted ref into a `local-node` script ref).
 */

import { spawn } from 'node:child_process';

import type { ExecutionRef } from '../common/execution-interface.js';
import { buildLocalBaseSpec, invokeExecutionRef } from './execution-adapter.js';
import { invokeBoardWorker } from '../public/board-worker-adapter.js';
import type { ExecutionRef as BoardWorkerExecutionRef } from '../public/board-worker-adapter.js';

export interface NonCoreExecutorDispatcherOpts {
  /** Rewrite the ref before dispatch (e.g. hosted → local-node). Identity if omitted. */
  resolveRef?: (ref: ExecutionRef) => ExecutionRef;
  /** Lazily resolves the CLI directory used by `local-*` spawn refs. */
  resolveCliDir?: () => string;
  /** Default timeouts surfaced as `BoardNonCorePlatformAdapter.executorTimeouts`. */
  executorTimeouts?: {
    validationMs?: number;
    preflightMs?: number;
    probeMs?: number;
    describeMs?: number;
  };
}

export interface NonCoreExecutorDispatcher {
  invokeExecutor(
    ref: ExecutionRef,
    subcommand: string,
    opts?: { timeout?: number; input?: string },
  ): Promise<string>;
  executorTimeouts?: NonCoreExecutorDispatcherOpts['executorTimeouts'];
}

export function createNonCoreExecutorDispatcher(
  opts: NonCoreExecutorDispatcherOpts = {},
): NonCoreExecutorDispatcher {
  const resolveRef = opts.resolveRef ?? ((ref: ExecutionRef) => ref);

  return {
    ...(opts.executorTimeouts ? { executorTimeouts: opts.executorTimeouts } : {}),
    async invokeExecutor(rawRef, subcommand, execOpts) {
      const ref = resolveRef(rawRef);

      if (ref.howToRun === 'queue-storage') {
        throw new Error('queue-storage does not support inline executor request/response');
      }

      if (ref.howToRun === 'http:post' || ref.howToRun === 'in-process-loop') {
        const result = await invokeBoardWorker(ref as BoardWorkerExecutionRef, {
          subcommand,
          ...(execOpts?.input !== undefined ? { input: execOpts.input } : {}),
        });
        if (typeof result === 'string') return result;
        if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as Record<string, unknown>).stdout === 'string') {
          return String((result as Record<string, unknown>).stdout);
        }
        return JSON.stringify(result ?? {});
      }

      if (ref.howToRun === 'http:get') {
        const result = await invokeExecutionRef(ref, {
          subcommand,
          ...(execOpts?.input !== undefined ? { input: execOpts.input } : {}),
          ...(ref.extra ? { extra: ref.extra } : {}),
        }, {
          cwd: process.cwd(),
          timeoutMs: execOpts?.timeout ?? 30_000,
          label: `invokeExecutor:${subcommand}`,
        });
        if (result.result !== 'success') {
          const detail = typeof result.data?.error === 'string' ? result.data.error : result.error;
          throw new Error(detail || `executor request failed: ${result.result}`);
        }
        if (typeof result.data?.stdout === 'string') return result.data.stdout;
        return JSON.stringify(result.data ?? {});
      }

      if (!opts.resolveCliDir) {
        throw new Error(`createNonCoreExecutorDispatcher: ref.howToRun="${ref.howToRun}" requires opts.resolveCliDir`);
      }
      const { command, baseArgs } = buildLocalBaseSpec(ref, opts.resolveCliDir());
      const extraFlag = ref.extra ? ['--extra', Buffer.from(JSON.stringify(ref.extra)).toString('base64')] : [];
      const argv = [...baseArgs, subcommand, ...extraFlag];

      return await new Promise<string>((resolve, reject) => {
        const child = spawn(command, argv, {
          cwd: process.cwd(),
          stdio: 'pipe',
          windowsHide: true,
          shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

        const finishReject = (error: Error & { stdout?: string; stderr?: string }) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(error);
        };

        const finishResolve = (stdout: string) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve(stdout);
        };

        child.stdout.on('data', (chunk) => { stdoutChunks.push(Buffer.from(chunk)); });
        child.stderr.on('data', (chunk) => { stderrChunks.push(Buffer.from(chunk)); });
        child.on('error', (error) => {
          const err = error as Error & { stdout?: string; stderr?: string };
          err.stdout = Buffer.concat(stdoutChunks).toString('utf-8');
          err.stderr = Buffer.concat(stderrChunks).toString('utf-8');
          finishReject(err);
        });
        child.on('close', (code) => {
          const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
          const stderr = Buffer.concat(stderrChunks).toString('utf-8');
          if (code === 0) {
            finishResolve(stdout);
            return;
          }
          const err = new Error(stderr.trim() || `executor exited with status ${code}`) as Error & { stdout?: string; stderr?: string };
          err.stdout = stdout;
          err.stderr = stderr;
          finishReject(err);
        });

        if (execOpts?.timeout && execOpts.timeout > 0) {
          timeoutHandle = setTimeout(() => {
            child.kill();
            const err = new Error(`executor timed out after ${execOpts.timeout}ms`) as Error & { stdout?: string; stderr?: string };
            err.stdout = Buffer.concat(stdoutChunks).toString('utf-8');
            err.stderr = Buffer.concat(stderrChunks).toString('utf-8');
            finishReject(err);
          }, execOpts.timeout);
        }

        if (execOpts?.input !== undefined) child.stdin.end(execOpts.input);
        else child.stdin.end();
      });
    },
  };
}
