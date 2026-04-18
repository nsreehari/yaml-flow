/**
 * portfolio-tracker.js
 *
 * Node.js port of portfolio-tracker.bat.
 * Runs the full T0-T4 lifecycle of the portfolio board demo.
 *
 * This is a BLACK-BOX client of board-live-cards CLI.
 * It only calls CLI commands and does NOT inspect board internals.
 *
 * Usage:  node portfolio-tracker.js
 *    or:  npx tsx portfolio-tracker.js   (from this directory)
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOARD = path.join(__dirname, 'board-runtime');
const CARDS = path.join(__dirname, 'cards');
const TMP_FILE = path.join(BOARD, 'tmp_file1');
// Change to the examples/board-live-cards directory so relative paths work
process.chdir(__dirname);
console.log(`Running from: ${process.cwd()}`);

const CLI_SCRIPT = path.join(__dirname, '..', '..', 'src', 'cli', 'board-live-cards.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cli(...args) {
  const result = spawnSync('npx', ['tsx', CLI_SCRIPT, ...args], {
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`\n[ERROR] board-live-cards ${args[0]} exited with status ${result.status}`);
    process.exit(1);
  }
}

/** Simple wait for board to settle (assumes CLI calls are blocking). */
async function waitForSettle(ms = 3_000) {
  console.log(`Waiting ${ms}ms for cascade to settle...`);
  await sleep(ms);
}

/** Write prices to tmp_file1 for source to read. */
function writePrices(prices) {
  // Ensure directory exists (tmp_file1 is just input, not internal state)
  if (!fs.existsSync(BOARD)) {
    fs.mkdirSync(BOARD, { recursive: true });
  }
  fs.writeFileSync(TMP_FILE, JSON.stringify(prices), 'utf-8');
  console.log(`Wrote prices: ${JSON.stringify(prices)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {

  // ==========================================================================
  // T0: Init board + add all 4 cards
  // ==========================================================================
  console.log('\n=== T0: Init board ===');
  if (fs.existsSync(BOARD)) fs.rmSync(BOARD, { recursive: true, force: true });

  cli('init', BOARD);

  // portfolio-form auto-completes (no sources, state has holdings)
  cli('add-card', '--rg', BOARD, '--card', path.join(CARDS, 'portfolio-form.json'));

  // price-fetch fires immediately (portfolio-form provides 'holdings')
  cli('add-card', '--rg', BOARD, '--card', path.join(CARDS, 'price-fetch.json'));

  // holdings-table waits for price-fetch to deliver prices
  cli('add-card', '--rg', BOARD, '--card', path.join(CARDS, 'holdings-table.json'));

  // portfolio-value waits for holdings-table to provide 'table'
  cli('add-card', '--rg', BOARD, '--card', path.join(CARDS, 'portfolio-value.json'));

  console.log('\n--- T0 Status (after add-card) ---');
  cli('status', '--rg', BOARD);

  // ==========================================================================
  // T1: Write prices — simulates external market feed arriving
  // ==========================================================================
  console.log('\n=== T1: Writing market prices ===');
  writePrices({ AAPL: 198.50, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });

  await waitForSettle(3_000);

  console.log('\n--- T1 Status ---');
  cli('status', '--rg', BOARD);

  // ==========================================================================
  // T2: Add GOOG (3rd holding) — update portfolio-form.json + restart
  // ==========================================================================
  console.log('\n=== T2: Adding GOOG (100 shares) ===');

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
  fs.writeFileSync(path.join(CARDS, 'portfolio-form.json'), JSON.stringify(portfolioFormV2, null, 2));

  cli('update-card', '--rg', BOARD, '--card-id', 'portfolio-form', '--restart');

  // price-fetch fires again — provide fresh prices
  await sleep(1_000);
  writePrices({ AAPL: 198.50, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });

  await waitForSettle(3_000);

  console.log('\n--- T2 Status ---');
  cli('status', '--rg', BOARD);

  // ==========================================================================
  // T3: Force price refresh — AAPL moved to 205.00
  // ==========================================================================
  console.log('\n=== T3: Force price refresh — AAPL now 205.00 ===');
  cli('retrigger', '--rg', BOARD, '--task', 'price-fetch');

  await sleep(1_000);
  writePrices({ AAPL: 205.00, MSFT: 425.30, GOOG: 178.90, AMZN: 192.40, TSLA: 168.75 });

  await waitForSettle(3_000);

  console.log('\n--- T3 Status ---');
  cli('status', '--rg', BOARD);

  // ==========================================================================
  // T4: Final quiescent check
  // ==========================================================================
  console.log('\n=== T4: Final board status ===');
  cli('status', '--rg', BOARD);

  console.log('\n✅ Portfolio tracker completed successfully');

})();
