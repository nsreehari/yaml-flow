import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GraphEvent } from '../event-graph/types.js';

// ============================================================================
// Local type aliases (mirrors non-exported types in main CLI module)
// ============================================================================

interface SourceTokenPayloadLike {
  cbk: string;
  rg: string;
  cid: string;
  b: string;
  d: string;
  cs?: string;
}

interface FetchRuntimeEntryLike {
  lastRequestedAt?: string;
  lastFetchedAt?: string;
  lastError?: string;
  queueRequestedAt?: string;
}

interface CardRuntimeStateLike {
  _sources: Record<string, FetchRuntimeEntryLike>;
  _inferenceEntry?: FetchRuntimeEntryLike;
}

// ============================================================================
// Dependency interfaces
// ============================================================================

interface TaskExecutorConfigLike {
  command: string;
  args?: string[];
  extra?: Record<string, unknown>;
}

interface ExecutionCommandDeps {
  INFERENCE_ADAPTER_FILE: string;
  TASK_EXECUTOR_LOG_FILE?: string;
  readTaskExecutorConfig: (boardDir: string) => TaskExecutorConfigLike | undefined;
  execCommandSync: (
    cmd: string,
    args: string[],
    options?: {
      shell?: boolean;
      timeout?: number;
      encoding?: BufferEncoding;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) => string;
  execCommandAsync: (
    cmd: string,
    args: string[],
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  splitCommandLine: (command: string) => string[];
  resolveCommandInvocation: (rawCmd: string, rawArgs: string[]) => { cmd: string; args: string[] };
  encodeSourceToken: (payload: SourceTokenPayloadLike) => string;
  decodeSourceToken: (token: string) => SourceTokenPayloadLike | null;
  decodeCallbackToken: (token: string) => { taskName: string } | null;
  spawnDetachedCommand: (cmd: string, args: string[]) => void;
  getCliInvocation: (command: string, args: string[]) => { cmd: string; args: string[] };
  appendTaskExecutorLog: (
    boardDir: string,
    hydratedSource: unknown,
    mode: 'external-task-executor' | 'built-in-run-source-fetch',
  ) => void;
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
  processAccumulatedEventsForced: (boardDir: string, options?: { inlineLoop?: boolean }) => Promise<void>;
  lookupCardPath: (boardDir: string, cardId: string) => string | null;
  nextEntryAfterFetchDelivery: <T extends FetchRuntimeEntryLike>(entry: T, fetchedAt: string) => T;
}

export interface ExecutionCommandHandlers {
  cmdRunSources: (args: string[]) => void;
  cmdRunInference: (args: string[]) => void;
  cmdInferenceDone: (args: string[]) => void;
  cmdTryDrain: (args: string[]) => Promise<void>;
}

// ============================================================================
// Factory
// ============================================================================

export function createExecutionCommandHandlers(deps: ExecutionCommandDeps): ExecutionCommandHandlers {
  // Local helpers used only by cmdRunSources
  function invokeSourceDataFetched(sourceToken: string, tmpFile: string, callback: (err: Error | null) => void): void {
    const { cmd, args } = deps.getCliInvocation('source-data-fetched', ['--tmp', tmpFile, '--token', sourceToken]);
    deps.execCommandAsync(cmd, args, (err, stdout, stderr) => {
      if (err) console.error(`[source-data-fetched] call failed:`, err.message);
      if (stdout) console.log(stdout.trim());
      if (stderr) console.error(stderr.trim());
      callback(err);
    });
  }

  function invokeSourceDataFetchFailure(sourceToken: string, reason: string, callback: (err: Error | null) => void): void {
    const { cmd, args } = deps.getCliInvocation('source-data-fetch-failure', ['--token', sourceToken, '--reason', reason]);
    deps.execCommandAsync(cmd, args, (err) => callback(err));
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
    const teConfig = deps.readTaskExecutorConfig(boardDir!);
    const taskExecutorCmd = teConfig?.command;
    const taskExecutorArgs = teConfig?.args ?? [];
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
      const sourceToken = deps.encodeSourceToken({
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

      if (taskExecutorCmd) {
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
        deps.appendTaskExecutorLog(boardDir!, sourceForExecutor, 'external-task-executor');
        fs.writeFileSync(inFile, JSON.stringify(sourceForExecutor, null, 2), 'utf-8');
        const executorArgs = [...taskExecutorArgs, 'run-source-fetch', '--in', inFile, '--out', outFile, '--err', errFile];
        if (taskExecutorExtraB64) executorArgs.push('--extra', taskExecutorExtraB64);
        console.log(`[run-sourcedefs-internal] task-executor: ${taskExecutorCmd} ${executorArgs.join(' ')}`);
        try {
          deps.execCommandSync(taskExecutorCmd, executorArgs, {
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
      deps.appendTaskExecutorLog(boardDir!, sourceForBuiltInExecutor, 'built-in-run-source-fetch');
      const cmdParts = deps.splitCommandLine(src.cli);
      if (cmdParts.length === 0) {
        const errMsg = 'source.cli command is empty';
        console.warn(`[run-sourcedefs-internal] source "${src.bindTo}": ${errMsg}`);
        reportFailure(errMsg);
        return;
      }

      const rawCmd = cmdParts[0];
      const { cmd, args: cliArgs } = deps.resolveCommandInvocation(rawCmd, cmdParts.slice(1));

      let stdout: string;
      try {
        stdout = deps.execCommandSync(cmd, cliArgs, {
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
    const decodedToken = deps.decodeSourceToken(inferenceToken);
    if (!decodedToken) {
      console.error('Invalid inference token');
      process.exit(1);
    }
    const callbackToken = decodedToken.cbk;
    const boardDir = decodedToken.rg;

    const cbkDecoded = deps.decodeCallbackToken(callbackToken);
    if (!cbkDecoded) {
      console.error('Invalid callback token embedded in inference token');
      process.exit(1);
    }

    function spawnInferenceDone(tmpFile: string): void {
      const { cmd, args: cliArgs } = deps.getCliInvocation('inference-done', ['--tmp', tmpFile, '--token', inferenceToken!]);
      deps.spawnDetachedCommand(cmd, cliArgs);
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

    const adapterFile = path.join(boardDir, deps.INFERENCE_ADAPTER_FILE);
    const inferenceAdapter = fs.existsSync(adapterFile) ? fs.readFileSync(adapterFile, 'utf-8').trim() : undefined;
    if (!inferenceAdapter) {
      spawnInferenceDoneError(`inference adapter is not configured (${deps.INFERENCE_ADAPTER_FILE})`);
      return;
    }

    const outFile = path.join(os.tmpdir(), `card-inference-out-${Date.now()}.json`);
    const errFile = path.join(os.tmpdir(), `card-inference-err-${Date.now()}.txt`);
    const adapterParts = deps.splitCommandLine(inferenceAdapter);
    if (adapterParts.length === 0) {
      spawnInferenceDoneError('inference adapter command is empty');
      return;
    }

    const adapterRawCmd = adapterParts[0];
    const adapterRawArgs = adapterParts.slice(1);
    const { cmd: adapterCmd, args: adapterArgsPrefix } = deps.resolveCommandInvocation(adapterRawCmd, adapterRawArgs);
    const adapterArgs = [...adapterArgsPrefix, 'run-inference', '--in', inFile, '--out', outFile, '--err', errFile];

    try {
      deps.execCommandSync(adapterCmd, adapterArgs, {
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

    const decodedToken = deps.decodeSourceToken(inferenceToken);
    if (!decodedToken) {
      console.error('Invalid inference token');
      process.exit(1);
    }

    const { cbk: callbackToken, rg: dir, cs: inputChecksum } = decodedToken;

    const decoded = deps.decodeCallbackToken(callbackToken);
    if (!decoded) {
      console.error('Invalid callback token embedded in inference token');
      process.exit(1);
    }

    const taskName = decoded.taskName;
    const cardPath = deps.lookupCardPath(dir, taskName);
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
    let runtime: CardRuntimeStateLike = { _sources: {} };
    if (fs.existsSync(runtimePath)) {
      try {
        runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8')) as CardRuntimeStateLike;
      } catch {}
    }

    const inferenceEntry = runtime._inferenceEntry ?? {};
    runtime._inferenceEntry = deps.nextEntryAfterFetchDelivery(inferenceEntry, inferenceCompletedAt);

    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2), 'utf-8');

    deps.appendEventToJournal(dir, {
      type: 'task-progress',
      taskName,
      update: {
        kind: 'inference-done',
        isTaskCompleted: isTaskCompletedFlag,
        inputChecksum,
      },
      timestamp: inferenceCompletedAt,
    });

    void deps.processAccumulatedEventsInfinitePass(dir);
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

    await deps.processAccumulatedEventsForced(boardDir, { inlineLoop });
  }

  return { cmdRunSources, cmdRunInference, cmdInferenceDone, cmdTryDrain };
}
