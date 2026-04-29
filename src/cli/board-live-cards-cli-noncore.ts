import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TaskExecutorConfigLike {
  command: string;
  args?: string[];
  extra?: Record<string, unknown>;
}

interface NonCoreCommandDeps {
  readTaskExecutorConfig: (boardDir: string) => TaskExecutorConfigLike | undefined;
  execCommandSync: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  splitCommandLine: (command: string) => string[];
  resolveCommandInvocation: (rawCmd: string, rawArgs: string[]) => { cmd: string; args: string[] };
}

export interface NonCoreCommandHandlers {
  cmdHelp: () => void;
  cmdRunSourceFetch: (args: string[]) => void;
  cmdProbeSource: (args: string[]) => Promise<void>;
  cmdDescribeTaskExecutorCapabilities: (args: string[]) => void;
}

export function createNonCoreCommandHandlers(deps: NonCoreCommandDeps): NonCoreCommandHandlers {
  function cmdRunSourceFetch(args: string[]): void {
    const inIdx = args.indexOf('--in');
    const outIdx = args.indexOf('--out');
    const errIdx = args.indexOf('--err');

    const inFile = inIdx !== -1 ? args[inIdx + 1] : undefined;
    const outFile = outIdx !== -1 ? args[outIdx + 1] : undefined;
    const errFile = errIdx !== -1 ? args[errIdx + 1] : undefined;

    if (!inFile || !outFile) {
      console.error('Usage: board-live-cards run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]');
      process.exit(1);
    }

    if (!fs.existsSync(inFile)) {
      const msg = `Input file not found: ${inFile}`;
      if (errFile) fs.writeFileSync(errFile, msg);
      console.error(`[run-source-fetch] ${msg}`);
      process.exit(1);
    }

    // Parse source definition
    let source: any;
    try {
      const raw = fs.readFileSync(inFile, 'utf-8');
      source = JSON.parse(raw);
    } catch (err) {
      const msg = `Failed to parse input file: ${(err as Error).message}`;
      if (errFile) fs.writeFileSync(errFile, msg);
      console.error(`[run-source-fetch] ${msg}`);
      process.exit(1);
    }

    // Source must have a cli field (not script)
    if (!source.cli) {
      const msg = 'Source definition missing cli field (board-live-cards built-in executor only understands source.cli)';
      if (errFile) fs.writeFileSync(errFile, msg);
      console.error(`[run-source-fetch] ${msg}`);
      process.exit(1);
    }

    // Execute the source cli command
    console.log(`[run-source-fetch] executing: ${source.cli}`);
    const timeout = source.timeout ?? 120_000;
    const sourceCwd = typeof source.cwd === 'string' ? source.cwd : process.cwd();
    const sourceBoardDir = typeof source.boardDir === 'string' ? source.boardDir : undefined;

    // Parse command with quote support to preserve args like --flag "value with spaces".
    const cmdParts = deps.splitCommandLine(source.cli);
    if (cmdParts.length === 0) {
      const msg = 'Source cli command is empty';
      if (errFile) fs.writeFileSync(errFile, msg);
      console.error(`[run-source-fetch] ${msg}`);
      process.exit(1);
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
      }) as string;
    } catch (err: unknown) {
      const msg = (err as Error).message ?? String(err);
      console.error(`[run-source-fetch] cli failed: ${msg}`);
      if (errFile) fs.writeFileSync(errFile, msg);
      process.exit(1);
    }

    // Write result to --out
    const result = stdout.trim();
    try {
      fs.writeFileSync(outFile, result);
      console.log(`[run-source-fetch] result written to ${outFile}`);
    } catch (err) {
      const msg = `Failed to write output file: ${(err as Error).message}`;
      console.error(`[run-source-fetch] ${msg}`);
      if (errFile) fs.writeFileSync(errFile, msg);
      process.exit(1);
    }
  }

  async function cmdProbeSource(args: string[]): Promise<void> {
    const cardIdx = args.indexOf('--card');
    const sourceIdxArg = args.indexOf('--source-idx');
    const sourceBindArg = args.indexOf('--source-bind');
    const mockProjectionsIdx = args.indexOf('--mock-projections');
    const rgIdx = args.indexOf('--rg');
    const outIdx = args.indexOf('--out');

    const cardFilePath = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
    const sourceIdxVal = sourceIdxArg !== -1 ? parseInt(args[sourceIdxArg + 1], 10) : 0;
    const sourceBindVal = sourceBindArg !== -1 ? args[sourceBindArg + 1] : undefined;
    const mockProjectionsRaw = mockProjectionsIdx !== -1 ? args[mockProjectionsIdx + 1] : undefined;
    const boardDirArg = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const outFile = outIdx !== -1 ? args[outIdx + 1] : undefined;

    if (!cardFilePath) {
      console.error('Usage: board-live-cards probe-source --card <card.json> [--source-idx <n>] [--source-bind <name>] [--mock-projections <json>] [--rg <boardDir>] [--out <result.json>]');
      process.exit(1);
    }

    // Read card
    let card: any;
    try {
      card = JSON.parse(fs.readFileSync(path.resolve(cardFilePath), 'utf-8'));
    } catch (e) {
      console.error(`[probe-source] Cannot read card: ${(e as Error).message}`);
      process.exit(1);
    }

    const source_defs: any[] = card.source_defs ?? [];
    if (source_defs.length === 0) {
      console.error(`[probe-source] Card "${card.id}" has no source_defs`);
      process.exit(1);
    }

    // Select source by index or bindTo name
    let sourceIdx: number;
    if (sourceBindVal) {
      sourceIdx = source_defs.findIndex((s: any) => s.bindTo === sourceBindVal);
      if (sourceIdx === -1) {
        console.error(`[probe-source] No source with bindTo="${sourceBindVal}" in card "${card.id}"`);
        process.exit(1);
      }
    } else {
      sourceIdx = sourceIdxVal;
      if (isNaN(sourceIdx) || sourceIdx < 0 || sourceIdx >= source_defs.length) {
        console.error(`[probe-source] --source-idx ${sourceIdxVal} out of range (card has ${source_defs.length} source(s))`);
        process.exit(1);
      }
    }

    const sourceDef = source_defs[sourceIdx];
    const cardDir = path.resolve(path.dirname(cardFilePath));
    const boardDir = boardDirArg ? path.resolve(boardDirArg) : cardDir;

    // Parse --mock-projections (JSON string or @file.json) — pre-resolved _projections values for testing
    let mockProjections: Record<string, unknown> = {};
    if (mockProjectionsRaw) {
      const raw = mockProjectionsRaw.startsWith('@')
        ? fs.readFileSync(path.resolve(mockProjectionsRaw.slice(1)), 'utf-8')
        : mockProjectionsRaw;
      try {
        mockProjections = JSON.parse(raw);
      } catch (e) {
        console.error(`[probe-source] --mock-projections is not valid JSON: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    // Detect registered task-executor
    const teConfig = deps.readTaskExecutorConfig(boardDir);
    const taskExecutorCmd = teConfig?.command;
    const taskExecutorBaseArgs = teConfig?.args ?? [];
    const taskExecutorExtraB64 = teConfig?.extra
      ? Buffer.from(JSON.stringify(teConfig.extra)).toString('base64')
      : undefined;

    // Build --in payload — mirrors exactly what run-sourcedefs-internal passes to the executor
    const inPayload: Record<string, unknown> = {
      ...sourceDef,
      cwd: typeof sourceDef.cwd === 'string' && sourceDef.cwd ? sourceDef.cwd : cardDir,
      boardDir: typeof sourceDef.boardDir === 'string' && sourceDef.boardDir ? sourceDef.boardDir : boardDir,
      _projections: mockProjections,
    };

    // Derive sourceKind from executor's describe-capabilities rather than hardcoding.
    // Call describe-capabilities, get sourceKinds keys, find which one appears in sourceDef.
    // Falls back to 'unknown' if executor is unavailable or call fails.
    let sourceKind = 'unknown';
    if (taskExecutorCmd) {
      try {
        const capRaw = deps.execCommandSync(taskExecutorCmd, [...taskExecutorBaseArgs, 'describe-capabilities'], {
          timeout: 8_000, encoding: 'utf-8',
        });
        const caps = JSON.parse(String(capRaw));
        const knownKinds: string[] = caps?.sourceKinds ? Object.keys(caps.sourceKinds) : [];
        const defKeys = new Set(Object.keys(sourceDef));
        sourceKind = knownKinds.find(k => defKeys.has(k)) ?? 'unknown';
      } catch {
        // describe-capabilities failed — fall back to 'unknown'; probe execution still proceeds
      }
    }

    console.log(`[probe-source] card:        ${card.id}`);
    console.log(`[probe-source] source[${sourceIdx}]:  bindTo="${sourceDef.bindTo}" kind=${sourceKind}`);
    console.log(`[probe-source] _projections:       ${JSON.stringify(mockProjections)}`);
    console.log(`[probe-source] executor:    ${taskExecutorCmd ?? 'built-in (source.cli only)'}`);
    console.log('[probe-source] running fetch...');

    const ts = Date.now();
    const inFile = path.join(os.tmpdir(), `probe-in-${sourceDef.bindTo}-${ts}.json`);
    const tmpOut = path.join(os.tmpdir(), `probe-out-${sourceDef.bindTo}-${ts}.json`);
    const errFile = path.join(os.tmpdir(), `probe-err-${sourceDef.bindTo}-${ts}.txt`);

    fs.writeFileSync(inFile, JSON.stringify(inPayload, null, 2), 'utf-8');

    let passed = false;
    let errorMsg: string | undefined;
    let resultRaw: string | undefined;

    try {
      if (taskExecutorCmd) {
        const executorArgs = [...taskExecutorBaseArgs, 'run-source-fetch', '--in', inFile, '--out', tmpOut, '--err', errFile];
        if (taskExecutorExtraB64) executorArgs.push('--extra', taskExecutorExtraB64);
        deps.execCommandSync(taskExecutorCmd, executorArgs, {
          timeout: (sourceDef.timeout as number) ?? 30_000,
        });
      } else {
        // Built-in path: only source.cli is supported
        if (!inPayload.cli) {
          throw new Error('No task-executor registered and source has no cli field — cannot probe with built-in executor');
        }
        const cmdParts = deps.splitCommandLine(inPayload.cli as string);
        const rawCmd = cmdParts[0];
        const { cmd, args: cliArgs } = deps.resolveCommandInvocation(rawCmd, cmdParts.slice(1));
        const stdout = deps.execCommandSync(cmd, cliArgs, {
          shell: false,
          encoding: 'utf-8',
          timeout: (sourceDef.timeout as number) ?? 30_000,
          cwd: inPayload.cwd as string,
        });
        fs.writeFileSync(tmpOut, String(stdout).trim(), 'utf-8');
      }

      passed = fs.existsSync(tmpOut);
      if (passed) {
        resultRaw = fs.readFileSync(tmpOut, 'utf-8');
      } else {
        errorMsg = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : 'executor produced no output file';
      }
    } catch (e) {
      errorMsg = (e as Error).message ?? String(e);
      if (!errorMsg && fs.existsSync(errFile)) {
        errorMsg = fs.readFileSync(errFile, 'utf-8').trim();
      }
    }

    // Cleanup temp inputs
    for (const f of [inFile, errFile]) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }

    // Report
    if (passed && resultRaw !== undefined) {
      const resultSize = resultRaw.length;
      const sample = resultRaw.slice(0, 300);
      console.log('[probe-source] STATUS:      PROBE_PASS');
      console.log(`[probe-source] result size: ${resultSize} bytes`);
      console.log(`[probe-source] sample:      ${sample}${resultSize > 300 ? '...' : ''}`);
      if (outFile) {
        fs.writeFileSync(path.resolve(outFile), resultRaw);
        console.log(`[probe-source] result written to: ${outFile}`);
      } else {
        try { fs.unlinkSync(tmpOut); } catch { /* best-effort */ }
      }
    } else {
      console.log('[probe-source] STATUS:      PROBE_FAIL');
      if (errorMsg) console.log(`[probe-source] error:       ${errorMsg}`);
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* best-effort */ }
    }

    // Machine-readable summary line — agents parse this
    const summary = {
      status: passed ? 'PROBE_PASS' : 'PROBE_FAIL',
      cardId: card.id as string,
      sourceIdx,
      bindTo: sourceDef.bindTo as string,
      sourceKind,
      mockProjectionsKeys: Object.keys(mockProjections),
      resultSizeBytes: resultRaw !== undefined ? resultRaw.length : 0,
      error: errorMsg ?? undefined,
    };
    console.log(`[probe-source:result] ${JSON.stringify(summary)}`);

    process.exit(passed ? 0 : 1);
  }

  function cmdDescribeTaskExecutorCapabilities(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const boardDir = rgIdx !== -1 ? path.resolve(args[rgIdx + 1]) : undefined;
    if (!boardDir) {
      console.error('Usage: board-live-cards describe-task-executor-capabilities --rg <dir>');
      process.exit(1);
    }

    const teConfig = deps.readTaskExecutorConfig(boardDir);
    if (!teConfig) {
      console.error(`[describe-task-executor-capabilities] No .task-executor registered in ${boardDir}`);
      process.exit(1);
    }

    try {
      const stdout = deps.execCommandSync(teConfig.command, [...(teConfig.args ?? []), 'describe-capabilities'], {
        timeout: 10_000,
        encoding: 'utf-8',
      });
      // Pass through the executor's JSON output directly
      process.stdout.write(String(stdout));
      if (!String(stdout).endsWith('\n')) process.stdout.write('\n');
    } catch (e) {
      console.error(`[describe-task-executor-capabilities] Executor failed: ${(e as Error).message ?? e}`);
      process.exit(1);
    }
  }

  function cmdHelp(): void {
    console.log(`
board-live-cards-cli — LiveCards board CLI

USAGE
  board-live-cards-cli <command> [options]

BOARD MANAGEMENT
  init <dir> [--task-executor <script>] [--chat-handler <script>] [--inference-adapter <script>] [--runtime-out <dir>]
    Create a new board in <dir>.
    If --task-executor is given, writes <dir>/.task-executor with the script path.
    If --chat-handler is given, writes <dir>/.chat-handler with the script path.
    If --inference-adapter is given, writes <dir>/.inference-adapter with the script path.
    Writes <dir>/.runtime-out (default: <dir>/runtime-out).
    Published runtime files:
      <runtime-out>/board-livegraph-status.json
      <runtime-out>/cards/<card-id>.computed.json
    Re-running init on an existing board is safe; handler registrations are updated.

  status --rg <dir> [--json]
    Read and print the published status snapshot from <runtime-out>/board-livegraph-status.json.
    --json emits the stable machine-readable status object.

CARD MANAGEMENT
  upsert-card --rg <dir> (--card <card.json> | --card-glob <glob>) [--card-id <card-id>] [--restart]
    Insert or update one or many cards.
    Enforces strict one-to-one mapping between card id and file path:
      - same id + same file path: update
      - new id + new file path: insert
      - id remap or file remap: rejected
    If --card-id is provided, it must match the id inside the file.
    --card-id is valid only with --card (single file), not with --card-glob.
    --restart clears the task so it re-triggers from scratch.

  validate-card (--card <card.json> | --card-glob <glob>) [--rg <boardDir>]
    Validate one or many card JSON files without adding them to a board.
    Checks JSON Schema structure, runtime expression syntax, and provides.ref namespaces.
    When --rg is provided, also invokes the board's task executor validate-source-def
    subcommand to structurally validate each source definition against supported kinds.
    Exits with code 1 if any card fails validation.

  remove-card --rg <dir> --id <card-id>
    Remove a card and its task from the board.

  retrigger --rg <dir> --task <task-name>
    Mark a task not-started and drain to re-trigger it.

TASK CALLBACKS  (called by task executor scripts)
  task-completed --token <callbackToken> [--data <json>]
    Signal successful task completion with optional JSON result data.

  task-failed --token <callbackToken> [--error <message>]
    Signal task failure with an optional error message.

  task-progress --rg <dir> --token <callbackToken> [--update <json>]
    Signal task progress with optional update payload (for waiting on more evidence, etc.).

SOURCE CALLBACKS  (called internally by run-sourcedefs-internal)
  source-data-fetched --tmp <file> --token <sourceToken>
    Atomically rename <file> into the outputFile destination and record delivery
    via journal events. Appends a task-progress event to re-invoke the card handler.

  source-data-fetch-failure --token <sourceToken> [--reason <message>]
    Record a source fetch failure via journal events and append a task-progress event.

INTERNAL COMMANDS
  process-accumulated-events --rg <dir>
    Executes forced drain for this board.
    This command is also used as the background relay worker.
    By default it schedules a detached worker and returns quickly.
    Internal workers run with --inline-loop to perform the settle loop.

    Eventual-progress guarantee is relay-based (not per-call blocking guarantee):
    1) at least one runner continues processing,
    2) no crash/forced exit in relay window,
    3) lock stays healthy,
    4) event production eventually quiesces.

  run-sourcedefs-internal --card <card.json> --token <callbackToken> --rg <dir>
    Execute all source[] entries for a card, then report delivery or failure.
    (Internal command — invoked by the card-handler. Not intended for direct use.)

    If <dir>/.task-executor exists, invokes it with run-source-fetch subcommand:
      <executor> run-source-fetch --in <source_json> --out <outfile> --err <errfile>

    If no .task-executor is registered, uses board-live-cards built-in run-source-fetch.

  run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
    Execute a source definition. Board-live-cards reads source.cli and executes it.
    Writes result to --out. Presence of --out after exit indicates success.

  describe-task-executor-capabilities --rg <dir>
    Invoke the registered task-executor's describe-capabilities subcommand and
    print its capabilities JSON to stdout.  Requires a .task-executor file in <dir>.

  probe-source --card <card.json> [--source-idx <n>] [--source-bind <name>]
               [--mock-projections <json>] [--rg <boardDir>] [--out <result.json>]
    Validate that a card source can be fetched successfully.
    Reads the card file, extracts the chosen source (default: index 0), builds the
    run-source-fetch --in payload with the supplied _projections data, invokes the
    registered task-executor (or built-in executor for source.cli), and reports pass/fail.
    --mock-projections:     JSON string (or @file.json) providing pre-resolved _projections values
                     the source needs.  Craft the minimal payload that exercises the
                     source — e.g. '{"holdings":[{"ticker":"AAPL","quantity":10}]}'.
                     If omitted, _projections is passed as empty ({}).
    --source-idx:    0-based index into card.source_defs[]. Default: 0.
    --source-bind:   Select source by its bindTo name instead of index.
    --rg:            Board directory used to find .task-executor. Defaults to the
                     directory containing the card file.
    --out:           Optional path to write the raw fetch result JSON.
    Prints a structured report ending with a [probe-source:result] JSON line.
    Exits 0 on PROBE_PASS, 1 on PROBE_FAIL.

  run-inference-internal --in <input.json> --token <inferenceToken>
    Execute inference via registered .inference-adapter and forward result to inference-done.
    inferenceToken encodes boardDir (rg), cardId (cid), callbackToken (cbk), checksum (cs).
    (Internal command — invoked by the card-handler when custom completion rule is used.)

  inference-done --tmp <result.json> --token <inferenceToken>
    Persist llm_task_completion_inference on the card and append a task-progress event.
    Reads boardDir/callbackToken/checksum from decoded inferenceToken; deletes --tmp file after reading.
    (Internal command — invoked by run-inference-internal.)

RUN-SOURCE-FETCH PROTOCOL
  External task-executors implement:
    <executor> run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]

  INPUT:   --in file contains the full source_defs[x] definition object
  OUTPUT:  --out file is written with the result to signal success.
           --err file may be written to explain failure.

  Exit code and --out presence determine success:
    Exit 0 + --out file present → source delivery recorded, card re-evaluated.
    Exit non-zero OR --out absent → source-data-fetch-failure recorded.

BOARD-LIVE-CARDS BUILT-IN EXECUTOR
  Understands source.cli field only:
    "source_defs": [{ "cli": "node ../fetch-prices.js", "bindTo": "prices", "outputFile": "prices.json" }]

  The source.cli command is executed with:
    - Direct command invocation (no shell; quote-aware argument parsing)
    - Stdout is captured and delivered to the card as-is
    - Timeout from source.timeout (default 120s)

  The source.cli command must:
    - Execute successfully (exit 0)
    - Write output to stdout
    - Complete within the timeout

  The output format is the concern of the card's compute function to interpret.

  External task-executors can interpret source definitions however they want.

EXAMPLES
  board-live-cards-cli init ./my-board
  board-live-cards-cli init ./my-board --task-executor ./executors/my-runner.py
  board-live-cards-cli upsert-card --rg ./my-board --card cards/prices.json
  board-live-cards-cli status --rg ./my-board
  board-live-cards-cli retrigger --rg ./my-board --task price-fetch
  board-live-cards-cli probe-source --card cards/card-market-prices.json --source-idx 0 --rg ./my-board --mock-projections '{"holdings":[{"ticker":"AAPL","quantity":10}]}'
`.trimStart());
  }

  return {
    cmdHelp,
    cmdRunSourceFetch,
    cmdProbeSource,
    cmdDescribeTaskExecutorCapabilities,
  };
}
