#!/usr/bin/env node
/**
 * demo-http-test.js
 *
 * Smoke test for public-examples/board/demo-server.js over HTTP + SSE.
 *
 * Usage:
 *   node demo-http-test.js [--port 7799]
 */

import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliArgs = process.argv.slice(2);
const portArg = cliArgs.indexOf('--port');
const cliPort = portArg !== -1 ? parseInt(cliArgs[portArg + 1], 10) : NaN;
const RUN_ID = `run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

const PORT = Number.isInteger(cliPort) && cliPort > 0 ? cliPort : await pickFreePort();

const BOARD_ID = 'default';
const BASE = `http://127.0.0.1:${PORT}/api/boards/${BOARD_ID}`;
const SERVER_SCRIPT = path.join(__dirname, '..', 'demo-server.js');
const SERVER_DIR = path.dirname(SERVER_SCRIPT);
const SSE_WORKER_SCRIPT = path.join(__dirname, 'portfolio-tracker-sse-worker.js');
const CARD_PATTERN = 'cardT*';

// Resolve and wipe the setup directory before starting the server so each
// test run begins from a clean slate.  The location is read from
// demo-server-config.json (setupDir key) with the same fallback the server uses.
function resolveSetupDirRoot() {
  const configPath = path.join(SERVER_DIR, 'demo-server-config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg && typeof cfg.setupDir === 'string' && cfg.setupDir.trim()) {
      return path.resolve(SERVER_DIR, cfg.setupDir.trim());
    }
  } catch { /* ignore */ }
  return path.join(SERVER_DIR, '.demo-setup');
}

const SETUP_DIR = path.join(resolveSetupDirRoot(), RUN_ID);
if (fs.existsSync(SETUP_DIR)) {
  fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  console.log(`[demo-http-test] wiped setup dir: ${SETUP_DIR}`);
}


const NS = {
  initialPayload: null,
  statusSummary: null,
  statusGeneration: 0,
  computedValues: {},
};

function applyFrame(payload) {
  if (payload && Array.isArray(payload.cardDefinitions)) {
    if (!NS.initialPayload && payload.cardDefinitions.length > 0) {
      NS.initialPayload = payload;
    }
    const summary = payload.statusSnapshot && payload.statusSnapshot.summary;
    if (summary) {
      NS.statusSummary = summary;
      NS.statusGeneration += 1;
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

  if (payload && payload.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
    for (const n of payload.notifications) {
      const summary = n && n.kind === 'status' && n.status && n.status.summary;
      if (summary) {
        NS.statusSummary = summary;
        NS.statusGeneration += 1;
      }
      if (n && n.kind === 'computed_values' && n.cardId) {
        NS.computedValues[n.cardId] = n.values;
      }
    }
  }
}

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
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`));
      }
    }, 150);
  });
}

const waitForInitialPayload = (ms = 15_000) =>
  waitUntil(() => NS.initialPayload || false, ms, 'initial SSE payload');

const waitForAllCompleted = (ms = 60_000, label = 'all completed') =>
  waitUntil(() => {
    const s = NS.statusSummary;
    if (s && s.card_count > 0 && s.completed === s.card_count) return s;
    return false;
  }, ms, label);

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

function httpJson(method, url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = payload != null ? JSON.stringify(payload) : null;
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_SCRIPT, '--cards-pattern', CARD_PATTERN], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DEMO_SERVER_PORT: String(port), DEMO_SETUP_DIR: SETUP_DIR },
    });
    let ready = false;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      process.stdout.write(`[server] ${text}`);
      if (!ready && text.includes('listening on')) {
        ready = true;
        resolve(proc);
      }
    });
    proc.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!ready) reject(new Error(`Server exited early: code ${code}`));
    });

    setTimeout(() => {
      if (!ready) reject(new Error('Server startup timeout (15s)'));
    }, 15_000);
  });
}

console.log('\n=== board HTTP+SSE smoke test ===');
console.log(`target: ${BASE}`);
console.log(`card pattern: ${CARD_PATTERN}`);

const serverProc = await startServer(PORT);
let sseWorker = null;

try {
  console.log('\n=== Step 1: init-board ===');
  const initRes = await httpGet(`${BASE}/init-board`);
  assert(initRes.status === 200, `init-board returned ${initRes.status}`);
  console.log('[step1] ok');

  console.log('\n=== Step 2: start SSE worker ===');
  sseWorker = new Worker(SSE_WORKER_SCRIPT, {
    workerData: { sseUrl: `${BASE}/sse?clientId=e2e-demo-sse` },
  });
  sseWorker.on('message', (msg) => {
    if (msg.type === 'frame') applyFrame(msg.payload);
    else if (msg.type === 'error') console.error(`[sse-worker] ${msg.message}`);
  });
  sseWorker.on('error', (err) => console.error(`[sse-worker] uncaught: ${err.message}`));

  const initialPayload = await waitForInitialPayload();
  const cardCount = Array.isArray(initialPayload.cardDefinitions) ? initialPayload.cardDefinitions.length : 0;
  assert(cardCount > 0, 'initial SSE payload must include cardDefinitions');
  console.log(`[step2] SSE initial payload received (${cardCount} cards)`);

  console.log('\n=== Step 3: wait for completion ===');
  const summary = await waitForAllCompleted(20_000, 'initial board completion');
  assert(summary.failed === 0, `expected failed=0, got ${summary.failed}`);
  console.log(`[step3] completed summary: ${JSON.stringify(summary)}`);

  console.log('\n=== Step 4: board-status cross-check ===');
  const statusRes = await httpGet(`${BASE}/board-status`);
  assert(statusRes.status === 200, `board-status returned ${statusRes.status}`);
  const httpSummary = statusRes.data && statusRes.data.statusSnapshot && statusRes.data.statusSnapshot.summary;
  assert(httpSummary, 'statusSnapshot.summary missing from board-status');
  console.log(`[step4] board-status summary: ${JSON.stringify(httpSummary)}`);

  // ── T1: PATCH holdings (+1 row) and verify recomputation ──
  console.log('\n=== T1: patch holdings (+1 row) ===');

  // Read current holdings from card store via GET /cards/:id
  const portfolioCardRes = await httpGet(`${BASE}/cards/card-portfolio`);
  assert(portfolioCardRes.status === 200, `GET card-portfolio returned ${portfolioCardRes.status}`);
  const existingHoldings = (portfolioCardRes.data.card_data || {}).holdings;
  assert(Array.isArray(existingHoldings), 'card-portfolio.card_data.holdings missing');
  const t0HoldingsCount = existingHoldings.length;

  // Read current positions count from computed_values captured via SSE
  const t0Positions = (NS.computedValues['card-portfolio-value'] || {}).positions;
  const t0PositionsCount = Array.isArray(t0Positions) ? t0Positions.length : 0;

  // Pick a ticker not already in holdings
  const candidates = ['AAPL', 'MSFT', 'AMZN', 'TSLA', 'META', 'GOOG', 'NVDA', 'NFLX', 'INTC', 'AMD',
    'IBM', 'ORCL', 'ADBE', 'CRM', 'QCOM'];
  const existingTickers = new Set(existingHoldings.map(r => r.ticker));
  const available = candidates.filter(t => !existingTickers.has(t));
  assert(available.length > 0, 'No available ticker to add');
  const newTicker = available[0];

  const newHoldings = [...existingHoldings, { ticker: newTicker, quantity: 1, cost_basis: 100 }];
  const patchRes = await httpJson('PATCH', `${BASE}/cards/card-portfolio`, { card_data: { holdings: newHoldings } });
  assert(patchRes.status === 200, `PATCH card-portfolio returned ${patchRes.status}`);

  // Wait for re-completion
  NS.statusSummary = null;
  await new Promise(r => setTimeout(r, 4000));
  const t1Summary = await waitForAllCompleted(30_000, 'T1 holdings patch');
  assert(t1Summary.failed === 0, `T1 failed=${t1Summary.failed}`);

  // Verify holdings +1 from card store
  const t1PortfolioRes = await httpGet(`${BASE}/cards/card-portfolio`);
  assert(t1PortfolioRes.status === 200, `GET card-portfolio after patch returned ${t1PortfolioRes.status}`);
  const afterHoldings = (t1PortfolioRes.data.card_data || {}).holdings;
  const afterHoldingsCount = Array.isArray(afterHoldings) ? afterHoldings.length : 0;

  // Verify positions +1 from computed_values captured via SSE
  const afterPositions = (NS.computedValues['card-portfolio-value'] || {}).positions;
  const afterPositionsCount = Array.isArray(afterPositions) ? afterPositions.length : 0;

  assert(afterHoldingsCount === t0HoldingsCount + 1,
    `Expected holdings rows +1 (before=${t0HoldingsCount}, after=${afterHoldingsCount})`);
  assert(afterPositionsCount === t0PositionsCount + 1,
    `Expected portfolio value rows +1 (before=${t0PositionsCount}, after=${afterPositionsCount})`);

  console.log(`[T1] ok: holdings ${t0HoldingsCount}->${afterHoldingsCount}, ` +
    `positions ${t0PositionsCount}->${afterPositionsCount}, added=${newTicker}`);

  console.log('\n=== All smoke checks passed ===\n');
} finally {
  // Kill server first so the SSE connection closes, then await worker termination.
  // (Terminating the worker while the SSE socket is still open leaves dangling handles.)
  serverProc.kill();
  await new Promise((r) => serverProc.on('exit', r));
  if (sseWorker) await sseWorker.terminate();
  console.log('[demo-http-test] server stopped');
}
