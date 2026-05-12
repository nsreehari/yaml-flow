#!/usr/bin/env node
/**
 * portfolio-tracker-http-test.js
 *
 * E2E test for the portfolio-tracker board via HTTP + SSE.
 *
 * Two parallel tracks:
 *
 *   Worker thread (portfolio-tracker-sse-worker.js) — SSE consumer
 *     Opens the board's /sse endpoint, parses every frame, and forwards it
 *     to the main thread via parentPort.postMessage({ type: 'frame', payload }).
 *
 *   Main thread (this file) — Test driver
 *     Accumulates state from worker messages into NotificationState (NS).
 *     Drives sequential test steps (T1–T5) via HTTP PATCH/GET.
 *     All "wait for X" helpers poll NS with setInterval — no callbacks needed.
 *
 * Usage:
 *   node portfolio-tracker-http-test.js [--port 7800] [--server node|py]
 */

import { Worker } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliArgs = process.argv.slice(2);
const portArg = cliArgs.indexOf('--port');
const serverArg = cliArgs.indexOf('--server');
const SERVER_TYPE = serverArg !== -1 ? cliArgs[serverArg + 1] : 'node'; // 'node' | 'py'
const PORT = portArg !== -1 ? parseInt(cliArgs[portArg + 1], 10) : (SERVER_TYPE === 'py' ? 7801 : 7800);
const BASE = `http://127.0.0.1:${PORT}/api/board`;
const SERVER_SCRIPT = path.join(__dirname, 'portfolio-tracker-server.js');
const PY_SERVER_SCRIPT = path.join(__dirname, 'portfolio-tracker-server.py');
const SSE_WORKER_SCRIPT = path.join(__dirname, 'portfolio-tracker-sse-worker.js');

/** Find a working Python interpreter. Returns null if none found. */
function findPython() {
  const candidates = ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'pipe', timeout: 3000 });
      if (r.status === 0 && r.stdout?.toString().startsWith('Python ')) return cmd;
    } catch { /* next */ }
  }
  return null;
}

// =============================================================================
// NOTIFICATION STATE — accumulated by the main thread from worker SSE frames
// =============================================================================
const NS = {
  initialPayload: null,     // first full snapshot frame
  statusSummary: null,      // latest { card_count, completed, failed, ... }
  statusGeneration: 0,      // bumped on every status notification received
  dataObjects: {},          // token → payload  (e.g. 'prices' → { AAPL: 142.5, ... })
  computedValues: {},       // cardId → values  (e.g. 'holdings-table' → { table: { rows: [...] } })
  cardRefreshedCount: 0,    // total card_refreshed notifications seen
  cardRefreshedByCardId: {},// cardId → count
};

// Apply a parsed SSE frame into NS (called from worker message handler)
function applyFrame(payload) {
    // Initial full snapshot — has cardDefinitions
    if (payload.cardDefinitions) {
      NS.initialPayload = payload;
      if (payload.statusSnapshot?.summary) {
        NS.statusSummary = payload.statusSnapshot.summary;
        NS.statusGeneration++;
      }
      if (payload.dataObjectsByToken) {
        Object.assign(NS.dataObjects, payload.dataObjectsByToken);
      }
      if (payload.cardRuntimeById) {
        for (const [cardId, runtime] of Object.entries(payload.cardRuntimeById)) {
          if (runtime?.computed_values && Object.keys(runtime.computed_values).length > 0) {
            NS.computedValues[cardId] = runtime.computed_values;
          }
        }
      }
      return;
    }
    // Subsequent frames — notification-batch
    if (payload.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
      for (const n of payload.notifications) {
        if (n.kind === 'status' && n.status?.summary) {
          NS.statusSummary = n.status.summary;
          NS.statusGeneration++;
        } else if (n.kind === 'data_object' && n.key) {
          NS.dataObjects[n.key] = n.payload;
        } else if (n.kind === 'computed_values' && n.cardId) {
          NS.computedValues[n.cardId] = n.values;
        } else if (n.kind === 'card_refreshed') {
          NS.cardRefreshedCount++;
          if (typeof n.cardId === 'string' && n.cardId) {
            NS.cardRefreshedByCardId[n.cardId] = (NS.cardRefreshedByCardId[n.cardId] || 0) + 1;
          }
        }
      }
    }
  }

  // ── Polling helpers (poll NS, never block the event loop) ───────────────────

  function assert(condition, message) {
    if (!condition) {
      console.error(`\n[ASSERT FAILED] ${message}`);
      process.exit(1);
    }
  }

  function waitUntil(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const interval = setInterval(() => {
        let result;
        try { result = predicate(); } catch { /* retry */ }
        if (result !== undefined && result !== null && result !== false) {
          clearInterval(interval);
          resolve(result);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}\n  NS.statusSummary=${JSON.stringify(NS.statusSummary)}\n  dataObjects=${JSON.stringify(Object.keys(NS.dataObjects))}`));
        }
      }, 150);
    });
  }

  // Waits for first full payload frame from SSE worker
  const waitForInitialPayload = (ms = 15_000) =>
    waitUntil(() => NS.initialPayload || false, ms, 'initial SSE payload');

  // Waits for all cards to reach completed status
  const waitForAllCompleted = (ms = 60_000, label = 'all completed') =>
    waitUntil(() => {
      const s = NS.statusSummary;
      return (s && s.card_count > 0 && s.completed === s.card_count) ? s : false;
    }, ms, label);

  // Waits until prices data object has exactly the expected set of symbols
  function waitForPriceSymbols(expectedSymbols, ms = 30_000, label = 'price symbols') {
    const expected = [...expectedSymbols].sort().join(',');
    return waitUntil(() => {
      const prices = NS.dataObjects['prices'];
      if (!prices || typeof prices !== 'object') return false;
      const actual = Object.keys(prices).sort().join(',');
      return actual === expected ? prices : false;
    }, ms, `${label}: expected [${expected}]`);
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, data: body }); }
        });
      }).on('error', reject);
    });
  }

  function httpPatch(url, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, data }); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  function makeHoldingsPatch(holdingsMap) {
    return {
      card_data: {
        holdings: Object.entries(holdingsMap).map(([symbol, qty]) => ({ symbol, qty })),
      },
    };
  }

  // ── Server process ────────────────────────────────────────────────────────────

  function startServer(port) {
    const isPy = SERVER_TYPE === 'py';
    let cmd, cmdArgs;
    if (isPy) {
      const python = findPython();
      if (!python) throw new Error('Python interpreter not found on PATH');
      cmd = python;
      cmdArgs = [PY_SERVER_SCRIPT, '--port', String(port), '--reset'];
    } else {
      cmd = process.execPath;
      cmdArgs = [SERVER_SCRIPT, '--port', String(port), '--reset'];
    }
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, cmdArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let ready = false;
      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf-8');
        process.stdout.write(`[server] ${text}`);
        if (!ready && text.includes('listening on')) { ready = true; resolve(proc); }
      });
      proc.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));
      proc.on('error', reject);
      proc.on('exit', (code) => { if (!ready) reject(new Error(`Server exited early: code ${code}`)); });
      setTimeout(() => { if (!ready) reject(new Error('Server startup timeout (15s)')); }, 15_000);
    });
  }

  // ── Main ──────────────────────────────────────────────────────────────────────

  console.log('\n=== portfolio-tracker HTTP E2E test ===');
  console.log(`target: ${BASE}  [server: ${SERVER_TYPE}]`);
  console.log(`architecture: main-thread (test driver) + worker-thread (SSE consumer)\n`);

  const serverProc = await startServer(PORT);
  await new Promise(r => setTimeout(r, 300)); // brief settle

  let sseWorker = null;
  try {
    // ── Step 1: init-board ──────────────────────────────────────────────────────
    console.log('\n=== Step 1: init-board ===');
    const initRes = await httpGet(`${BASE}/init-board`);
    assert(initRes.status === 200, `init-board returned ${initRes.status}`);
    console.log('[step1] ok');

    // ── Step 2: Start SSE consumer worker ───────────────────────────────────────
    // The worker opens /sse and forwards every parsed frame here via postMessage.
    // Main thread accumulates frames into NS via applyFrame().
    console.log('\n=== Step 2: Start SSE consumer worker ===');
    sseWorker = new Worker(SSE_WORKER_SCRIPT, {
      workerData: { sseUrl: `${BASE}/sse` },
    });
    sseWorker.on('message', (msg) => {
      if (msg.type === 'frame') {
        applyFrame(msg.payload);
      } else if (msg.type === 'error') {
        console.error(`[sse-worker] error: ${msg.message}`);
      } else if (msg.type === 'closed') {
        console.log('[sse-worker] SSE stream closed by server');
      }
    });
    sseWorker.on('error', (err) => console.error(`[sse-worker] uncaught: ${err.message}`));

    const initialPayload = await waitForInitialPayload();
    console.log(`[step2] SSE worker online — initial payload (${initialPayload.cardDefinitions?.length ?? 0} cards)`);
    console.log(`        statusGen=${NS.statusGeneration}, dataObjects=${JSON.stringify(Object.keys(NS.dataObjects))}`);

    // ── T1: Wait for initial drain ──────────────────────────────────────────────
    console.log('\n=== T1: Wait for initial completion ===');
    const t1Summary = await waitForAllCompleted(60_000, 'T1 initial drain');
    console.log(`[T1] board completed — ${JSON.stringify(t1Summary)}`);

    const t1Prices = await waitForPriceSymbols(['AAPL', 'MSFT'], 30_000, 'T1 prices');
    assert(Object.values(t1Prices).every(v => typeof v === 'number'), 'T1: all prices must be numbers');
    const t1Table = NS.computedValues['holdings-table']?.table;
    assert(Array.isArray(t1Table?.rows) && t1Table.rows.length === 2, `T1: expected 2 rows, got ${t1Table?.rows?.length}`);
    const t1Total = NS.computedValues['portfolio-value']?.totalValue;
    assert(typeof t1Total === 'number' && t1Total > 0, `T1: totalValue must be positive, got ${t1Total}`);
    console.log(`[T1] passed: prices=[AAPL,MSFT], rows=2, totalValue=${t1Total.toFixed(2)}`);

    // ── T2a: Add GOOG to holdings ────────────────────────────────────────────────
    console.log('\n=== T2a: Update holdings — add GOOG ===');
    const t2CardRefreshedBefore = NS.cardRefreshedCount;
    const t2Patch = await httpPatch(
      `${BASE}/cards/portfolio-form`,
      makeHoldingsPatch({ AAPL: 50, MSFT: 30, GOOG: 100 }),
    );
    assert(t2Patch.status === 200, `PATCH portfolio-form returned ${t2Patch.status}`);
    console.log('[T2a] PATCH ok — worker will receive SSE notifications independently');

    // ── T2b: Wait for 3-ticker completion ───────────────────────────────────────
    console.log('\n=== T2b: Wait for 3-ticker completion ===');
    const t2Summary = await waitForAllCompleted(60_000, 'T2b 3-ticker drain');
    console.log(`[T2b] completed — ${JSON.stringify(t2Summary)}`);

    const t2Prices = await waitForPriceSymbols(['AAPL', 'GOOG', 'MSFT'], 30_000, 'T2b prices');
    const t2CardRefreshedAfter = NS.cardRefreshedCount;
    assert(
      t2CardRefreshedAfter > t2CardRefreshedBefore,
      `T2b: expected at least one card_refreshed notification after PATCH (before=${t2CardRefreshedBefore}, after=${t2CardRefreshedAfter})`,
    );
    const t2Table = NS.computedValues['holdings-table']?.table;
    assert(Array.isArray(t2Table?.rows) && t2Table.rows.length === 3, `T2b: expected 3 rows, got ${t2Table?.rows?.length}`);
    const t2Total = NS.computedValues['portfolio-value']?.totalValue;
    assert(typeof t2Total === 'number' && t2Total > 0, 'T2b: totalValue must be positive');
    console.log(`[T2b] passed: prices=[AAPL,GOOG,MSFT], rows=3, totalValue=${t2Total.toFixed(2)}`);

    // ── T3: Rapid 3× holdings updates (queue stress) ─────────────────────────────
    // The worker independently streams all SSE notifications while the driver
    // fires rapid PATCHes. NS accumulates state continuously in both cases.
    console.log('\n=== T3: Rapid 3× holdings updates ===');
    const rapidUpdates = [
      { AAPL: 45, MSFT: 30, GOOG: 110, TSLA: 60 },
      { AAPL: 45, MSFT: 30, GOOG: 110, AMZN: 100 }, // intermediate — not expected to be final
      { AAPL: 40, MSFT: 35, GOOG: 120, TSLA: 70 },  // V5 — expected final state
    ];
    for (const holdings of rapidUpdates) {
      await httpPatch(`${BASE}/cards/portfolio-form`, makeHoldingsPatch(holdings));
    }
    console.log('[T3] rapid PATCHes sent — worker accumulates SSE state in parallel');

    await waitForAllCompleted(60_000, 'T3 rapid-update drain');
    const t3Prices = await waitForPriceSymbols(['AAPL', 'GOOG', 'MSFT', 'TSLA'], 30_000, 'T3 final prices');
    const t3Table = NS.computedValues['holdings-table']?.table;
    assert(Array.isArray(t3Table?.rows) && t3Table.rows.length === 4, `T3: expected 4 rows, got ${t3Table?.rows?.length}`);
    assert(!Object.keys(t3Prices).includes('AMZN'), `T3: AMZN must not be present (got ${JSON.stringify(Object.keys(t3Prices))})`);
    console.log(`[T3] passed: prices=${JSON.stringify(Object.keys(t3Prices).sort())}, rows=4, AMZN absent`);

    // ── T4: Cross-verify portfolio-value totalValue ───────────────────────────────
    console.log('\n=== T4: Cross-verify totalValue ===');
    const t4Total = NS.computedValues['portfolio-value']?.totalValue;
    assert(typeof t4Total === 'number' && t4Total > 0, `T4: totalValue must be positive, got ${t4Total}`);
    const sumRows = t3Table.rows.reduce((acc, r) => acc + (r.value || 0), 0);
    assert(Math.abs(sumRows - t4Total) < 0.01, `T4: mismatch: sumRows=${sumRows}, totalValue=${t4Total}`);
    console.log(`[T4] passed: totalValue=${t4Total.toFixed(2)}, sumRows=${sumRows.toFixed(2)}`);

    // ── T5: board-status HTTP cross-check ────────────────────────────────────────
    // Compare the HTTP board-status endpoint response against what the worker
    // accumulated via SSE — the two sources must agree.
    console.log('\n=== T5: board-status HTTP cross-check ===');
    const t5Res = await httpGet(`${BASE}/board-status`);
    assert(t5Res.status === 200, `board-status returned ${t5Res.status}`);
    const t5Summary = t5Res.data?.statusSnapshot?.summary;
    assert(t5Summary, 'T5: statusSnapshot.summary missing from board-status');
    assert(t5Summary.completed === t5Summary.card_count,
      `T5: completed=${t5Summary.completed} !== card_count=${t5Summary.card_count}`);
    assert(t5Summary.failed === 0, `T5: failed=${t5Summary.failed} (expected 0)`);

    // Cross-check: dataObjects from HTTP response matches what worker accumulated
    const httpDataObjKeys = Object.keys(t5Res.data.dataObjectsByToken || {}).sort().join(',');
    const workerDataObjKeys = Object.keys(NS.dataObjects).sort().join(',');
    assert(httpDataObjKeys === workerDataObjKeys,
      `T5: HTTP dataObjects keys [${httpDataObjKeys}] differ from worker-accumulated [${workerDataObjKeys}]`);

    console.log(`[T5] summary: ${JSON.stringify(t5Summary)}`);
    console.log(`[T5] HTTP vs worker dataObjects agree: [${workerDataObjKeys}]`);
    console.log(`[T5] statusGen at end: ${NS.statusGeneration}`);
    console.log('[T5] all assertions passed');

    console.log('\n=== All tests passed ✓ ===\n');

  } finally {
    // Kill server first so the SSE connection closes, then await worker termination.
    // (Terminating the worker while the SSE socket is still open leaves dangling handles.)
    serverProc.kill();
    await new Promise(r => serverProc.once('exit', r));
    if (sseWorker) await sseWorker.terminate();
    console.log(`[portfolio-tracker-http-test] server stopped (${SERVER_TYPE})`);
  }
