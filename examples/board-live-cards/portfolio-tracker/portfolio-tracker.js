/**
 * portfolio-tracker.js
 *
 * Runs the full T0-T4 lifecycle of the portfolio board demo.
 *
 * This is a BLACK-BOX client of board-live-cards CLI.
 * It only calls CLI commands and does NOT inspect board internals.
 *
 * Usage: node portfolio-tracker.js
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const CARDS_TEMPLATE = path.join(__dirname, 'cards');
const CLI_WRAPPER = path.join(__dirname, '..', '..', '..', 'board-live-cards-cli.js');
const CLI_TS = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'board-live-cards-cli.ts');
const CLI_JS = path.join(__dirname, '..', '..', '..', 'dist', 'cli', 'board-live-cards-cli.js');

// Keep runtime artifacts out of the repository.
const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-tracker-'));
const BOARD = path.join(RUNTIME_ROOT, 'board-runtime');
const CARDS = path.join(RUNTIME_ROOT, 'cards');
const TMP_FILE = path.join(BOARD, 'tmp_file1');

console.log(`Runtime root: ${RUNTIME_ROOT}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cliCommand() {
  if (fs.existsSync(CLI_WRAPPER)) {
    return { cmd: 'node', prefixArgs: [CLI_WRAPPER] };
  }
  if (fs.existsSync(CLI_JS)) {
    return { cmd: 'node', prefixArgs: [CLI_JS] };
  }
  return { cmd: NPX_CMD, prefixArgs: ['tsx', CLI_TS] };
}

function runCli(args, capture = false) {
  const { cmd, prefixArgs } = cliCommand();
  const useShell = process.platform === 'win32' && cmd.toLowerCase().endsWith('.cmd');
  const result = spawnSync(cmd, [...prefixArgs, ...args], {
    stdio: capture ? 'pipe' : 'inherit',
    shell: useShell,
    windowsHide: true,
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

function statusText() {
  return runCli(['status', '--rg', BOARD], true) ?? '';
}

async function waitForAllCompleted(label, timeoutMs = 30000, pollMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const out = statusText();
    const completed = [
      /\bcompleted\s+portfolio-form\b/.test(out),
      /\bcompleted\s+price-fetch\b/.test(out),
      /\bcompleted\s+holdings-table\b/.test(out),
      /\bcompleted\s+portfolio-value\b/.test(out),
    ].every(Boolean);

    if (completed) {
      console.log(`${label}: all cards completed.`);
      return;
    }

    await sleep(pollMs);
  }

  console.error(`[ERROR] ${label}: timed out waiting for all cards to complete.`);
  console.error(statusText());
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

(async () => {
  setupRuntimeCards();

  console.log('\n=== T0: Init board ===');
  fs.rmSync(BOARD, { recursive: true, force: true });

  cli('init', BOARD);
  cli('add-card', '--rg', BOARD, '--card', path.join(CARDS, 'portfolio-form.json'));
  cli('add-card', '--rg', BOARD, '--card', path.join(CARDS, 'price-fetch.json'));
  cli('add-card', '--rg', BOARD, '--card', path.join(CARDS, 'holdings-table.json'));
  cli('add-card', '--rg', BOARD, '--card', path.join(CARDS, 'portfolio-value.json'));

  console.log('\n--- T0 Status (after add-card) ---');
  process.stdout.write(statusText());

  console.log('\n=== T1: Writing market prices ===');
  writePrices({ AAPL: 198.50, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });
  await waitForAllCompleted('T1');

  console.log('\n--- T1 Status ---');
  process.stdout.write(statusText());

  console.log('\n=== T2: Adding GOOG (100 shares) ===');
  const portfolioFormPath = path.join(CARDS, 'portfolio-form.json');
  const portfolioFormV2 = {
    id: 'portfolio-form',
    meta: { title: 'Portfolio Holdings Form' },
    provides: [{ bindTo: 'holdings', src: 'state.holdings' }],
    state: {
      holdings: [
        { symbol: 'AAPL', qty: 50 },
        { symbol: 'MSFT', qty: 30 },
        { symbol: 'GOOG', qty: 100 },
      ],
    },
    view: {
      elements: [
        { kind: 'table', label: 'Holdings', data: { bind: 'state.holdings', columns: ['symbol', 'qty'] } },
      ],
    },
  };
  fs.writeFileSync(portfolioFormPath, JSON.stringify(portfolioFormV2, null, 2));

  cli('update-card', '--rg', BOARD, '--card-id', 'portfolio-form', '--restart');
  await sleep(500);
  writePrices({ AAPL: 198.50, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });
  await waitForAllCompleted('T2');

  console.log('\n--- T2 Status ---');
  process.stdout.write(statusText());

  console.log('\n=== T3: Force price refresh — AAPL now 205.00 ===');
  cli('retrigger', '--rg', BOARD, '--task', 'price-fetch');
  await sleep(500);
  writePrices({ AAPL: 205.00, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });
  await waitForAllCompleted('T3');

  console.log('\n--- T3 Status ---');
  process.stdout.write(statusText());

  console.log('\n=== T4: Final board status ===');
  process.stdout.write(statusText());

  console.log('\nPortfolio tracker completed successfully');
})();
