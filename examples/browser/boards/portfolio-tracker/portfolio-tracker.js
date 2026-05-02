/**
 * portfolio-tracker.js
 *
 * Runs the full T0-T4 lifecycle of the portfolio board demo.
 *
 * This is a BLACK-BOX client of board-live-cards CLI.
 * It only calls CLI commands and does NOT inspect board internals.
 *
 * Usage:
 *   node portfolio-tracker.js
 *   node portfolio-tracker.js --task-executor <path>
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CARDS_TEMPLATE = path.join(__dirname, 'cards');
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const CLI_WRAPPER = path.join(REPO_ROOT, 'board-live-cards-cli.js');
const CLI_TS = path.join(REPO_ROOT, 'src', 'cli', 'board-live-cards-cli.ts');
const CLI_JS = path.join(REPO_ROOT, 'dist', 'cli', 'board-live-cards-cli.js');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// Keep runtime artifacts out of the repository.
const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-tracker-'));
const BOARD = path.join(RUNTIME_ROOT, 'board-runtime');
const CARDS = path.join(RUNTIME_ROOT, 'cards');
const TMP_FILE = path.join(BOARD, 'tmp_file1');

function parseArgs(argv) {
  let taskExecutor;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--task-executor') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('[ERROR] Missing value for --task-executor');
        process.exit(1);
      }
      taskExecutor = value;
      i += 1;
      continue;
    }
    console.error(`[ERROR] Unknown argument: ${arg}`);
    process.exit(1);
  }
  return { taskExecutor };
}

const options = parseArgs(process.argv.slice(2));

console.log(`Runtime root: ${RUNTIME_ROOT}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cliCommand() {
  // Prefer node+tsx CLI on Windows to avoid flashing transient cmd windows.
  if (fs.existsSync(CLI_TS) && fs.existsSync(TSX_CLI)) {
    return { cmd: process.execPath, prefixArgs: [TSX_CLI, CLI_TS] };
  }
  if (fs.existsSync(CLI_WRAPPER)) {
    return { cmd: process.execPath, prefixArgs: [CLI_WRAPPER] };
  }
  if (fs.existsSync(CLI_JS)) {
    return { cmd: process.execPath, prefixArgs: [CLI_JS] };
  }
  return { cmd: process.execPath, prefixArgs: [CLI_WRAPPER] };
}

function runCli(args, capture = false) {
  const { cmd, prefixArgs } = cliCommand();
  const env = { ...process.env };
  // This demo needs real worker dispatch; suppressing spawn keeps source/inference tasks in running state.
  delete env.BOARD_LIVE_CARDS_NO_SPAWN;
  const result = spawnSync(cmd, [...prefixArgs, ...args], {
    stdio: capture ? 'pipe' : 'inherit',
    shell: false,
    windowsHide: true,
    env,
    encoding: capture ? 'utf-8' : undefined,
  });

  if (result.error) {
    console.error(`[ERROR] Failed to run CLI ${args[0]}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    if (capture && result.stdout) process.stdout.write(result.stdout);
    if (capture && result.stderr) process.stderr.write(result.stderr);
    console.error(`\n[ERROR] board-live-cards-cli ${args[0]} exited with status ${result.status}`);
    process.exit(1);
  }

  return capture ? result.stdout : undefined;
}

function cli(...args) {
  runCli(args, false);
}

/** Spawn CLI with JSON piped to stdin. */
function runCliWithInput(args, inputJson) {
  const { cmd, prefixArgs } = cliCommand();
  const env = { ...process.env };
  delete env.BOARD_LIVE_CARDS_NO_SPAWN;
  const result = spawnSync(cmd, [...prefixArgs, ...args], {
    input: inputJson,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
    windowsHide: true,
    env,
    encoding: 'utf-8',
  });
  if (result.error) {
    console.error(`[ERROR] Failed to run CLI ${args[0]}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n[ERROR] board-live-cards-cli ${args[0]} exited with status ${result.status}`);
    process.exit(1);
  }
}

/**
 * Write card to board's card store then upsert it.
 * Replaces old --card <file> flag (now removed from CLI).
 */
function upsertCardFromFile(boardDir, cardFilePath, restart = false) {
  const card = JSON.parse(fs.readFileSync(cardFilePath, 'utf-8'));
  const baseRef = `::fs-path::${boardDir}`;
  runCliWithInput(
    ['updates-in-card-store', '--base-ref', baseRef],
    JSON.stringify({ ops: [{ op: 'update', id: card.id, 'card-content': card }] }),
  );
  const args = ['upsert-card', '--base-ref', baseRef, '--card-id', card.id];
  if (restart) args.push('--restart');
  cli(...args);
}

/**
 * Expand a simple glob pattern (*.ext) and upsert each matching file.
 * Replaces old --card-glob <pattern> flag (now removed from CLI).
 */
function upsertCardsFromGlob(boardDir, globPattern) {
  const dir = path.dirname(globPattern);
  const basename = path.basename(globPattern);
  let files;
  if (basename.startsWith('*.')) {
    const ext = basename.slice(1);
    files = fs.readdirSync(dir).filter(f => f.endsWith(ext)).map(f => path.join(dir, f));
  } else if (basename === '*') {
    files = fs.readdirSync(dir).map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile());
  } else {
    files = [globPattern];
  }
  for (const file of files) {
    upsertCardFromFile(boardDir, file);
  }
}

/** Parse the JSON status response from the CLI. */
function parseStatusData(jsonText) {
  try {
    return JSON.parse(jsonText)?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Format the JSON status output as a human-readable table matching the
 * old text-mode status format:  "<status>  <name>  [<provides>]"
 */
function formatStatusTable(jsonText) {
  const statusData = parseStatusData(jsonText);
  if (!statusData?.cards) return jsonText;
  return statusData.cards
    .map(card => {
      const provides = card.provides_declared?.length
        ? `[${card.provides_declared.join(', ')}]`
        : '[]';
      return `${card.status}  ${card.name}  ${provides}`;
    })
    .join('\n') + '\n';
}

function statusText() {
  return runCli(['status', '--base-ref', `::fs-path::${BOARD}`], true) ?? '';
}

async function waitForAllCompleted(label, timeoutMs = 90000, pollMs = 500) {
  const start = Date.now();
  const includeInferenceCards = fs.existsSync(path.join(CARDS, 'portfolio-risk-assessment.json'))
    && fs.existsSync(path.join(CARDS, 'rebalancing-strategy.json'));

  while (Date.now() - start < timeoutMs) {
    const json = statusText();
    const statusData = parseStatusData(json);
    const cards = statusData?.cards ?? [];
    const isCompleted = (name) => cards.some(c => c.name === name && c.status === 'completed');

    const requiredCards = [
      isCompleted('portfolio-form'),
      isCompleted('price-fetch'),
      isCompleted('holdings-table'),
      isCompleted('portfolio-value'),
    ];
    if (includeInferenceCards) {
      requiredCards.push(
        isCompleted('portfolio-risk-assessment'),
        isCompleted('rebalancing-strategy'),
      );
    }

    if (requiredCards.every(Boolean)) {
      console.log(`${label}: all cards completed.`);
      return;
    }

    await sleep(pollMs);
  }

  console.error(`[ERROR] ${label}: timed out waiting for all cards to complete.`);
  console.error(formatStatusTable(statusText()));
  process.exit(1);
}

function writePrices(prices) {
  if (!fs.existsSync(BOARD)) {
    fs.mkdirSync(BOARD, { recursive: true });
  }
  fs.writeFileSync(TMP_FILE, JSON.stringify(prices), 'utf-8');
  console.log(`Wrote prices: ${JSON.stringify(prices)}`);
}

function setupRuntimeCards() {
  fs.rmSync(CARDS, { recursive: true, force: true });
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  fs.cpSync(CARDS_TEMPLATE, CARDS, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fetch-prices.js'), path.join(RUNTIME_ROOT, 'fetch-prices.js'));
}

function printTaskExecutorLog() {
  console.log('\n=== Task Executor Log (board-dir) ===');
  const candidates = fs
    .readdirSync(BOARD, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes('executor'))
    .map(entry => path.join(BOARD, entry.name));
  const taskExecutorLog = candidates.find(p => path.basename(p) === 'task-executor.jsonl') ?? candidates[0];
  if (!taskExecutorLog) {
    console.log(`No task executor log found in board-dir: ${BOARD}`);
    return;
  }

  console.log(`Log file: ${taskExecutorLog}`);
  const content = fs.readFileSync(taskExecutorLog, 'utf-8');
  process.stdout.write(content || '(empty)\n');
}

(async () => {
  setupRuntimeCards();

  console.log('\n=== T0: Init board ===');
  fs.rmSync(BOARD, { recursive: true, force: true });

  if (options.taskExecutor) {
    // Convert legacy "node /path/to/script" value to ExecutionRef JSON body
    let scriptPath = options.taskExecutor.trim();
    if (scriptPath.startsWith('node ')) scriptPath = scriptPath.slice(5).trim();
    const taskExecutorRef = { meta: 'task-executor', howToRun: 'local-node', whatToRun: `::fs-path::${scriptPath}` };
    runCliWithInput(
      ['init', '--base-ref', `::fs-path::${BOARD}`],
      JSON.stringify({ 'task-executor-ref': taskExecutorRef }),
    );
  } else {
    cli('init', '--base-ref', `::fs-path::${BOARD}`);
  }
  upsertCardsFromGlob(BOARD, path.join(CARDS, '*.json'));

  console.log('\n--- T0 Status (after upsert-card) ---');
  process.stdout.write(formatStatusTable(statusText()));

  console.log('\n=== T1: Writing market prices ===');
  writePrices({ AAPL: 198.50, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });
  await waitForAllCompleted('T1');

  console.log('\n--- T1 Status ---');
  process.stdout.write(formatStatusTable(statusText()));

  console.log('\n=== T2: Adding GOOG (100 shares) ===');
  const portfolioFormPath = path.join(CARDS, 'portfolio-form.json');
  const portfolioFormV2 = {
    id: 'portfolio-form',
    meta: { title: 'Portfolio Holdings Form' },
    provides: [{ bindTo: 'holdings', ref: 'card_data.holdings' }],
    card_data: {
      holdings: [
        { symbol: 'AAPL', qty: 50 },
        { symbol: 'MSFT', qty: 30 },
        { symbol: 'GOOG', qty: 100 },
      ],
    },
    view: {
      elements: [
        { kind: 'table', label: 'Holdings', data: { bind: 'card_data.holdings', columns: ['symbol', 'qty'] } },
      ],
    },
  };
  fs.writeFileSync(portfolioFormPath, JSON.stringify(portfolioFormV2, null, 2));

  upsertCardFromFile(BOARD, portfolioFormPath, true);
  await sleep(500);
  writePrices({ AAPL: 198.50, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });
  await waitForAllCompleted('T2');

  console.log('\n--- T2 Status ---');
  process.stdout.write(formatStatusTable(statusText()));

  console.log('\n=== T3: Force price refresh — AAPL now 205.00 ===');
  cli('retrigger', '--base-ref', `::fs-path::${BOARD}`, '--id', 'price-fetch');
  await sleep(500);
  writePrices({ AAPL: 205.00, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });
  await waitForAllCompleted('T3');

  console.log('\n--- T3 Status ---');
  process.stdout.write(formatStatusTable(statusText()));

  console.log('\n=== T4: Rapid successive portfolio updates (3x queue stress) ===');
  fs.writeFileSync(TMP_FILE, '', 'utf-8');

  const portfolioFormV3 = {
    id: 'portfolio-form',
    meta: { title: 'Portfolio Holdings Form' },
    provides: [{ bindTo: 'holdings', ref: 'card_data.holdings' }],
    card_data: {
      holdings: [
        { symbol: 'AAPL', qty: 50 },
        { symbol: 'MSFT', qty: 30 },
        { symbol: 'GOOG', qty: 100 },
        { symbol: 'AMZN', qty: 40 },
      ],
    },
    view: {
      elements: [
        { kind: 'table', label: 'Holdings', data: { bind: 'card_data.holdings', columns: ['symbol', 'qty'] } },
      ],
    },
  };

  const portfolioFormV4 = {
    id: 'portfolio-form',
    meta: { title: 'Portfolio Holdings Form' },
    provides: [{ bindTo: 'holdings', ref: 'card_data.holdings' }],
    card_data: {
      holdings: [
        { symbol: 'AAPL', qty: 45 },
        { symbol: 'MSFT', qty: 30 },
        { symbol: 'GOOG', qty: 110 },
        { symbol: 'TSLA', qty: 60 },
      ],
    },
    view: {
      elements: [
        { kind: 'table', label: 'Holdings', data: { bind: 'card_data.holdings', columns: ['symbol', 'qty'] } },
      ],
    },
  };

  const portfolioFormV5 = {
    id: 'portfolio-form',
    meta: { title: 'Portfolio Holdings Form' },
    provides: [{ bindTo: 'holdings', ref: 'card_data.holdings' }],
    card_data: {
      holdings: [
        { symbol: 'AAPL', qty: 40 },
        { symbol: 'MSFT', qty: 35 },
        { symbol: 'GOOG', qty: 120 },
        { symbol: 'TSLA', qty: 70 },
      ],
    },
    view: {
      elements: [
        { kind: 'table', label: 'Holdings', data: { bind: 'card_data.holdings', columns: ['symbol', 'qty'] } },
      ],
    },
  };

  // First update starts a source fetch request.
  fs.writeFileSync(portfolioFormPath, JSON.stringify(portfolioFormV3, null, 2));
  upsertCardFromFile(BOARD, portfolioFormPath, true);

  // Immediate second update should queue a newer checksum while the first request is in-flight.
  fs.writeFileSync(portfolioFormPath, JSON.stringify(portfolioFormV4, null, 2));
  upsertCardFromFile(BOARD, portfolioFormPath, true);

  // Immediate third update should overwrite queued checksum (latest-state wins).
  fs.writeFileSync(portfolioFormPath, JSON.stringify(portfolioFormV5, null, 2));
  upsertCardFromFile(BOARD, portfolioFormPath, true);

  // 7) wait for first request, then 8) write response prices for update #1 tickers.
  // await readFetchRequest('T4 first fetch', ['AAPL', 'MSFT', 'GOOG', 'AMZN']);
  writePrices({ AAPL: 205.00, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40 });
  await sleep(5000);

  // 9) wait for second request, then 10) write response prices for update #5 tickers.
  // await readFetchRequest('T4 second fetch', ['AAPL', 'MSFT', 'GOOG', 'TSLA']);
  writePrices({ AAPL: 206.00, MSFT: 426.00, GOOG: 179.50, TSLA: 169.20 });

  await waitForAllCompleted('T4');

  console.log('\n--- T4 Status ---');
  process.stdout.write(formatStatusTable(statusText()));

  console.log('\n=== T5: Final board status ===');
  process.stdout.write(formatStatusTable(statusText()));

  printTaskExecutorLog();

  console.log('\nPortfolio tracker completed successfully');
})();
