#!/usr/bin/env node
/**
 * demo-http-test.js
 *
 * Smoke test for demo-board/server/board-server.js over HTTP + SSE.
 * Targets the 'live' board with --cards-pattern cardT* to load only the 3
 * test cards (cardT-portfolio, cardT-market-prices, cardT-portfolio-value).
 *
 * T0: init-board → SSE initial payload → wait for all cards to complete
 * T1: PATCH holdings (+1 row) → verify recomputation (holdings +1, positions +1)
 *
 * Usage:
 *   node test/server-http-test.js [--port 7799]
 */

import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';

const ECHO_PROBE_MARKER = '__probe__echo__probe__';
const PROBE_IN_PROGRESS_TEXT = 'in-progress';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliArgs = process.argv.slice(2);
const portArg = cliArgs.indexOf('--port');
const cliPort = portArg !== -1 ? parseInt(cliArgs[portArg + 1], 10) : NaN;
const skipT1 = cliArgs.includes('--skip-t1');
const skipT2 = cliArgs.includes('--skip-t2');
const skipT3 = cliArgs.includes('--skip-t3');
const skipT4 = cliArgs.includes('--skip-t4');
const skipT5 = cliArgs.includes('--skip-t5');
function isCopilotAvailable() {
  try {
    const r = spawnSync('copilot', ['--version'], { timeout: 5_000, stdio: 'ignore', windowsHide: true });
    return !r.error;
  } catch { return false; }
}

const skipT3a = cliArgs.includes('--skip-t3a') || !isCopilotAvailable();
const skipT3b = cliArgs.includes('--skip-t3b');
const RUN_ID = `run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

const BOARD_ID = 'live';
const BOARD_DIR = path.resolve(__dirname, '..');
const SERVER_SCRIPT = path.resolve(BOARD_DIR, 'server', 'board-server.js');
const SSE_WORKER_SCRIPT = path.join(__dirname, 'sse-worker.js');
const CARD_PATTERN = 'cardT*';
const T2_FILE_CARD_ID = 'card-market-prices';
const CHAT_CARD_ID = 'card-portfolio';

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

async function resolveServerPort() {
  if (Number.isInteger(cliPort) && cliPort > 0) return cliPort;
  return findFreePort();
}

const PORT = await resolveServerPort();
const BASE = `http://127.0.0.1:${PORT}/api/boards/${BOARD_ID}`;

// Always use a system temp directory so parallel runs and vitest don't collide.
function resolveSetupDirRoot() {
  return os.tmpdir();
}

const SETUP_DIR = path.join(resolveSetupDirRoot(), RUN_ID);
const BOARD_SETUP_ROOT = path.join(SETUP_DIR, 'boards');
if (fs.existsSync(SETUP_DIR)) {
  fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  console.log(`[demo-http-test] wiped setup dir: ${SETUP_DIR}`);
}

// ---------------------------------------------------------------------------
// Shared state — accumulated from SSE frames
// ---------------------------------------------------------------------------

const NS = {
  initialPayload: null,
  statusSummary: null,
  statusGeneration: 0,
  computedValues: {},
  chatEvents: [],
  boardEvents: [],
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
      if (n && (n.kind === 'card_removed' || n.kind === 'card_refreshed') && n.cardId) {
        NS.boardEvents.push({ kind: n.kind, cardId: n.cardId, at: Date.now() });
      }
    }
  }
}

function normalizeSseChunkBuffer(buf, chunk) {
  return (buf + chunk.replace(/\r\n/g, '\n'));
}

function parseSseBlocks(buffer) {
  const payloads = [];
  let buf = buffer;
  while (true) {
    const idx = buf.indexOf('\n\n');
    if (idx === -1) break;
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    const data = dataLines.join('\n');
    if (!data) continue;
    try {
      payloads.push(JSON.parse(data));
    } catch { /* ignore malformed */ }
  }
  return { payloads, remainder: buf };
}

function startSseClient(sseUrl, onPayload) {
  const req = http.get(sseUrl, (res) => {
    let buf = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk) => {
      buf = normalizeSseChunkBuffer(buf, chunk);
      const parsed = parseSseBlocks(buf);
      buf = parsed.remainder;
      for (const payload of parsed.payloads) onPayload(payload);
    });
  });
  req.on('error', () => {});
  return {
    close() {
      try { req.destroy(); } catch { /* */ }
    },
  };
}

function captureChatEvents(payload, cardId) {
  if (!payload || payload.kind !== 'notification-batch' || !Array.isArray(payload.notifications)) return;
  for (const n of payload.notifications) {
    if (n && n.kind === 'card_chats' && n.cardId === cardId) {
      const messages = Array.isArray(n.messages) ? n.messages : [];
      NS.chatEvents.push({
        at: Date.now(),
        cardId: n.cardId,
        processing: !!n.processing,
        receiving: !!n.receiving,
        messageCount: messages.length,
        messages,
      });
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`\n[ASSERT FAILED] ${message}`);
    process.exit(1);
  }
}

function randomTurnId() {
  return String(Math.floor(100000 + Math.random() * 900000));
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChildProcess(proc, label) {
  if (!proc) return;
  if (proc.exitCode !== null) return;

  const exitPromise = new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });

  try {
    proc.kill();
  } catch {
    return;
  }

  const gracefulExit = await Promise.race([
    exitPromise,
    wait(5_000).then(() => null),
  ]);
  if (gracefulExit) return;

  if (proc.exitCode === null) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }

  const forcedExit = await Promise.race([
    exitPromise,
    wait(5_000).then(() => null),
  ]);
  if (!forcedExit && proc.exitCode === null) {
    throw new Error(`${label} did not exit after kill()`);
  }
}

const waitForInitialPayload = (ms = 15_000) =>
  waitUntil(() => NS.initialPayload || false, ms, 'initial SSE payload');

const waitForAllCompleted = (ms = 60_000, label = 'all completed') =>
  waitUntil(() => {
    const s = NS.statusSummary;
    if (s && s.card_count > 0 && s.completed === s.card_count) return s;
    return false;
  }, ms, label);

const waitForChatPredicate = (predicate, ms, label) =>
  waitUntil(() => predicate(NS.chatEvents) || false, ms, label);

function deriveProbeLifecycleMilestones(events, opts) {
  const milestones = [];
  let prevMessageCount = Number(opts.beforeCount || 0);
  let prevProcessing = Boolean(opts.beforeProcessing);
  const prompt = String(opts.prompt || '');
  const assistantText = opts.assistantText == null ? `Echo: ${prompt}` : String(opts.assistantText);
  const inProgressText = String(opts.inProgressText || PROBE_IN_PROGRESS_TEXT);

  for (const event of events) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const nextMessageCount = Number(event?.messageCount || messages.length || 0);
    const newMessages = nextMessageCount > prevMessageCount
      ? messages.slice(prevMessageCount, nextMessageCount)
      : [];

    for (const message of newMessages) {
      const role = String(message?.role || '');
      const text = String(message?.text || '');
      if (role === 'user' && text.includes(prompt)) milestones.push('user');
      else if (role === 'system' && text.trim().toLowerCase() === inProgressText) milestones.push('in-progress');
      else if (role === 'assistant' && text.includes(assistantText)) milestones.push('assistant');
    }

    const processing = Boolean(event?.processing);
    if (processing !== prevProcessing) milestones.push(processing ? 'processing-true' : 'processing-false');

    prevMessageCount = nextMessageCount;
    prevProcessing = processing;
  }

  return milestones;
}

function matchOrderedProbeLifecycle(events, opts) {
  const milestones = deriveProbeLifecycleMilestones(events, opts);
  if (milestones.length !== 5) return false;
  const firstPair = milestones.slice(0, 2);
  const lastPair = milestones.slice(3, 5);
  const firstOk = firstPair.includes('user') && firstPair.includes('processing-true');
  const middleOk = milestones[2] === 'in-progress';
  const lastOk = lastPair.includes('assistant') && lastPair.includes('processing-false');
  return (firstOk && middleOk && lastOk) ? { milestones } : false;
}

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

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', c => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          headers: res.headers,
        });
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

function httpMcp(tool, args) {
  return httpJson('POST', `${BASE}/mcp`, { tool, args });
}

function httpMcpControlplane(tool, args) {
  return httpJson('POST', `${BASE}/mcp-controlplane`, { tool, args });
}

function httpMcpRaw(tool, args) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE}/mcp-raw`);
    const data = JSON.stringify({ tool, args });
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpUploadChatFile(url, fileName, content, contentType = 'text/plain; charset=utf-8') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(content, 'utf-8');
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': data.length,
        'x-file-name': encodeURIComponent(fileName),
      },
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
    req.write(data);
    req.end();
  });
}

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectMcpSuccess(httpResult, label) {
  assert(httpResult.status === 200, `${label} returned ${httpResult.status}`);
  assert(httpResult.data?.status === 'success', `${label} expected status=success, got ${JSON.stringify(httpResult.data)}`);
  return httpResult.data.data;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        DEMO_SERVER_PORT: String(port),
        DEMO_SETUP_DIR: SETUP_DIR,
        DEMO_BOARD_SETUP_ROOT: BOARD_SETUP_ROOT,
        DEMO_CARDS_PATTERN: CARD_PATTERN,
        BOARD_SERVER_ENABLE_TEST_REQ: '1',
      },
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

    const startupTimer = setTimeout(() => {
      if (!ready) reject(new Error('Server startup timeout (15s)'));
    }, 15_000);
    startupTimer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// Test sequence
// ---------------------------------------------------------------------------

console.log('\n=== live board HTTP+SSE smoke test ===');
console.log(`target: ${BASE}`);
console.log(`card pattern: ${CARD_PATTERN}`);

const serverProc = await startServer(PORT);
let sseWorker = null;
let chatSseClient = null;
let chatSseClientId = '';

try {
  // ── T0: init-board, SSE connect, wait for initial completion ──

  // Register the 'live' board via POST (v8 runtime requires explicit registration)
  const regRes = await httpJson('POST', `http://127.0.0.1:${PORT}/api/boards`, { id: BOARD_ID, label: 'Live' });
  assert(regRes.status === 200 || regRes.status === 201 || regRes.status === 409,
    `POST /api/boards returned ${regRes.status}: ${JSON.stringify(regRes.data)}`);
  console.log(`[setup] board '${BOARD_ID}' registered (${regRes.status})`);

  console.log('\n=== T0 Step 1: init-board ===');
  const initRes = await httpGet(`${BASE}/init-board`);
  assert(initRes.status === 200, `init-board returned ${initRes.status}`);
  console.log('[T0.1] init-board ok');

  console.log('\n=== T0 Step 2: start SSE worker ===');
  const sseClientId = `server-http-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sseUrl = `${BASE}/sse?clientId=${encodeURIComponent(sseClientId)}`;
  sseWorker = new Worker(SSE_WORKER_SCRIPT, {
    workerData: { sseUrl },
  });
  sseWorker.on('message', (msg) => {
    if (msg.type === 'frame') applyFrame(msg.payload);
    else if (msg.type === 'error') console.error(`[sse-worker] ${msg.message}`);
  });
  sseWorker.on('error', (err) => console.error(`[sse-worker] uncaught: ${err.message}`));

  const initialPayload = await waitForInitialPayload();
  const cardCount = Array.isArray(initialPayload.cardDefinitions) ? initialPayload.cardDefinitions.length : 0;
  assert(cardCount === 3, `expected 3 cards (cardT*), got ${cardCount}`);
  const cardIds = initialPayload.cardDefinitions.map(c => c.id).sort();
  console.log(`[T0.2] SSE initial payload received (${cardCount} cards: ${cardIds.join(', ')})`);

  console.log('\n=== T0 Step 3: wait for all cards to complete ===');
  const t0Summary = await waitForAllCompleted(30_000, 'T0 initial completion');
  assert(t0Summary.failed === 0, `T0 expected failed=0, got ${t0Summary.failed}`);
  console.log(`[T0.3] completed: ${JSON.stringify(t0Summary)}`);

  console.log('\n=== T0 Step 4: board-status cross-check ===');
  const statusRes = await httpGet(`${BASE}/board-status`);
  assert(statusRes.status === 200, `board-status returned ${statusRes.status}`);
  const httpSummary = statusRes.data?.statusSnapshot?.summary;
  assert(httpSummary, 'statusSnapshot.summary missing from board-status');
  const statusMcpRes = await httpMcp('inspect.board-runtime-status', {});
  assert(statusMcpRes.status === 200, `inspect.board-runtime-status returned ${statusMcpRes.status}`);
  assert(statusMcpRes.data?.status === 'success', `inspect.board-runtime-status failed: ${JSON.stringify(statusMcpRes.data)}`);
  const mcpSummary = statusMcpRes.data?.data?.summary;
  assert(mcpSummary, 'summary missing from inspect.board-runtime-status');
  const comparableStatusKeys = ['card_count', 'completed', 'eligible', 'pending', 'blocked', 'in_progress', 'failed', 'unresolved'];
  const httpComparableSummary = Object.fromEntries(comparableStatusKeys.map((key) => [key, httpSummary[key]]));
  const mcpComparableSummary = Object.fromEntries(comparableStatusKeys.map((key) => [key, mcpSummary[key]]));
  assert(JSON.stringify(httpComparableSummary) === JSON.stringify(mcpComparableSummary),
    `HTTP board-status summary mismatch vs MCP summary: http=${JSON.stringify(httpComparableSummary)} mcp=${JSON.stringify(mcpComparableSummary)}`);
  assert(httpSummary.completed === httpSummary.card_count, `not all complete: ${JSON.stringify(httpSummary)}`);
  console.log(`[T0.4] board-status: ${JSON.stringify(httpSummary)}`);

  // Verify computed_values arrived for portfolio-value card
  const t0Positions = NS.computedValues['card-portfolio-value']?.positions;
  assert(Array.isArray(t0Positions) && t0Positions.length > 0, 'T0 positions missing from computed_values');
  console.log(`[T0] ok: ${t0Positions.length} positions computed`);

  // ── T1: PATCH holdings (+1 row), verify recomputation ──
  if (skipT1) {
    console.log('\n=== T1: skipped (--skip-t1) ===');
  } else {
    console.log('\n=== T1: local mutation + manage.upsert-card (+1 row) ===');

  // Read the live card document via inspect.card-definition-and-runtime before preparing the upsert payload.
  const portfolioCardRes = await httpMcp('inspect.card-definition-and-runtime', { card_id: 'card-portfolio' });
  assert(portfolioCardRes.status === 200, `inspect.card-definition-and-runtime returned ${portfolioCardRes.status}`);
  assert(portfolioCardRes.data?.status === 'success', `inspect.card-definition-and-runtime failed: ${JSON.stringify(portfolioCardRes.data)}`);
  const existingCard = portfolioCardRes.data?.data?.card_definition_and_static_data ?? null;
  const existingHoldings = existingCard?.card_data?.holdings;
  assert(Array.isArray(existingHoldings), 'card-portfolio.card_data.holdings missing');
  const t0HoldingsCount = existingHoldings.length;
  const t0PositionsCount = t0Positions.length;

  // Pick a ticker not already in holdings
  const candidates = ['AAPL', 'MSFT', 'AMZN', 'TSLA', 'META', 'GOOG', 'NVDA', 'NFLX', 'INTC', 'AMD',
    'IBM', 'ORCL', 'ADBE', 'CRM', 'QCOM'];
  const existingTickers = new Set(existingHoldings.map(r => r.ticker));
  const available = candidates.filter(t => !existingTickers.has(t));
  assert(available.length > 0, 'No available ticker to add');
  const newTicker = available[0];

  const newHoldings = [...existingHoldings, { ticker: newTicker, quantity: 1, cost_basis: 100 }];
  const nextCard = {
    ...existingCard,
    card_data: {
      ...(existingCard?.card_data || {}),
      holdings: newHoldings,
    },
  };
  const upsertRes = await httpMcp('manage.upsert-card', {
    card_id: 'card-portfolio',
    candidate_card_content: nextCard,
  });
  assert(upsertRes.status === 200, `manage.upsert-card returned ${upsertRes.status}`);
  assert(upsertRes.data?.status === 'success', `manage.upsert-card failed: ${JSON.stringify(upsertRes.data)}`);

  // Wait for re-completion after the upsert triggers a new cycle
  NS.statusSummary = null;
  await new Promise(r => setTimeout(r, 4000));
  const t1Summary = await waitForAllCompleted(30_000, 'T1 holdings upsert');
  assert(t1Summary.failed === 0, `T1 failed=${t1Summary.failed}`);

  // Verify holdings +1 from the live card document after upsert.
  const t1PortfolioRes = await httpMcp('inspect.card-definition-and-runtime', { card_id: 'card-portfolio' });
  assert(t1PortfolioRes.status === 200, `inspect.card-definition-and-runtime after upsert returned ${t1PortfolioRes.status}`);
  assert(t1PortfolioRes.data?.status === 'success', `inspect.card-definition-and-runtime after upsert failed: ${JSON.stringify(t1PortfolioRes.data)}`);
  const afterHoldings = t1PortfolioRes.data?.data?.card_definition_and_static_data?.card_data?.holdings;
  const afterHoldingsCount = Array.isArray(afterHoldings) ? afterHoldings.length : 0;

  // Verify positions +1 from computed_values captured via SSE
  const afterPositions = NS.computedValues['card-portfolio-value']?.positions;
  const afterPositionsCount = Array.isArray(afterPositions) ? afterPositions.length : 0;

  assert(afterHoldingsCount === t0HoldingsCount + 1,
    `Expected holdings rows +1 (before=${t0HoldingsCount}, after=${afterHoldingsCount})`);
  assert(afterPositionsCount === t0PositionsCount + 1,
    `Expected positions rows +1 (before=${t0PositionsCount}, after=${afterPositionsCount})`);
  console.log(`[T1] ok: holdings ${t0HoldingsCount}->${afterHoldingsCount}, ` +
    `positions ${t0PositionsCount}->${afterPositionsCount}, added=${newTicker}`);
  }

  // ── T2: plain file upload API + card_data.files + download roundtrip ──
  if (skipT2) {
    console.log('\n=== T2: skipped (--skip-t2) ===');
  } else {
    console.log('\n=== T2: plain file upload -> card_data.files -> download ===');
    const t2CardBefore = await httpGet(`${BASE}/cards/${T2_FILE_CARD_ID}`);
    assert(t2CardBefore.status === 200, `T2 pre card read returned ${t2CardBefore.status}`);
    const t2FilesBefore = Array.isArray(t2CardBefore.data?.card_data?.files)
      ? t2CardBefore.data.card_data.files
      : [];
    const t2BeforeCount = t2FilesBefore.length;

    const t2UploadText = `plain-file-upload-${Date.now()}`;
    const t2UploadName = 't2-upload.txt';
    const t2UploadRes = await httpUploadChatFile(
      `${BASE}/cards/${T2_FILE_CARD_ID}/files`,
      t2UploadName,
      t2UploadText,
    );
    assert(t2UploadRes.status === 200, `T2 file upload returned ${t2UploadRes.status}`);
    const t2UploadedFile = t2UploadRes.data?.file;
    assert(t2UploadedFile && typeof t2UploadedFile === 'object', 'T2 upload response missing file metadata');
    assert(String(t2UploadedFile?.name || '') === t2UploadName, 'T2 uploaded file name mismatch');

    const t2CardAfter = await httpGet(`${BASE}/cards/${T2_FILE_CARD_ID}`);
    assert(t2CardAfter.status === 200, `T2 post card read returned ${t2CardAfter.status}`);
    const t2FilesAfter = Array.isArray(t2CardAfter.data?.card_data?.files)
      ? t2CardAfter.data.card_data.files
      : [];
    assert(t2FilesAfter.length === t2BeforeCount + 1, `T2 expected files +1 (before=${t2BeforeCount}, after=${t2FilesAfter.length})`);

    const t2FileIndex = t2FilesAfter.findIndex((f) => String(f?.stored_name || '') === String(t2UploadedFile?.stored_name || ''));
    assert(t2FileIndex >= 0, 'T2 uploaded file metadata not found in card_data.files');

    const t2DownloadRes = await httpGetRaw(
      `${BASE}/cards/${T2_FILE_CARD_ID}/files/${t2FileIndex}?sn=${encodeURIComponent(String(t2UploadedFile?.stored_name || ''))}`,
    );
    assert(t2DownloadRes.status === 200, `T2 file download returned ${t2DownloadRes.status}`);
    const t2DownloadedText = t2DownloadRes.body.toString('utf-8');
    assert(t2DownloadedText === t2UploadText, 'T2 downloaded content mismatch');
    console.log('[T2] ok: card_data.files updated and file download endpoint returned exact bytes');

    console.log('\n=== T2a: MCP controlplane file upload -> MCP raw file download ===');
    const t2aCardBefore = await httpMcp('manage.read-card', { card_id: T2_FILE_CARD_ID });
    assert(t2aCardBefore.status === 200, `T2a pre card read returned ${t2aCardBefore.status}`);
    assert(t2aCardBefore.data?.status === 'success', `T2a pre card read failed: ${JSON.stringify(t2aCardBefore.data)}`);
    const t2aCardBeforeObj = Array.isArray(t2aCardBefore.data?.data) ? t2aCardBefore.data.data[0] : null;
    const t2aFilesBefore = Array.isArray(t2aCardBeforeObj?.card_data?.files) ? t2aCardBeforeObj.card_data.files : [];
    const t2aBeforeCount = t2aFilesBefore.length;

    const t2aUploadText = `mcp-file-upload-${Date.now()}`;
    const t2aUploadName = 't2a-upload.txt';
    const t2aUploadRes = await httpMcpControlplane('manage.upload-card-file', {
      board_id: BOARD_ID,
      card_id: T2_FILE_CARD_ID,
      file_name: t2aUploadName,
      content_type: 'text/plain; charset=utf-8',
      text: t2aUploadText,
    });
    assert(t2aUploadRes.status === 200, `T2a file upload returned ${t2aUploadRes.status}`);
    assert(t2aUploadRes.data?.status === 'success', `T2a file upload failed: ${JSON.stringify(t2aUploadRes.data)}`);
    const t2aUploadedFile = t2aUploadRes.data?.data?.file;
    assert(t2aUploadedFile && typeof t2aUploadedFile === 'object', 'T2a upload response missing file metadata');
    assert(String(t2aUploadedFile?.name || '') === t2aUploadName, 'T2a uploaded file name mismatch');

    const t2aCardAfter = await httpMcp('manage.read-card', { card_id: T2_FILE_CARD_ID });
    assert(t2aCardAfter.status === 200, `T2a post card read returned ${t2aCardAfter.status}`);
    assert(t2aCardAfter.data?.status === 'success', `T2a post card read failed: ${JSON.stringify(t2aCardAfter.data)}`);
    const t2aCardAfterObj = Array.isArray(t2aCardAfter.data?.data) ? t2aCardAfter.data.data[0] : null;
    const t2aFilesAfter = Array.isArray(t2aCardAfterObj?.card_data?.files) ? t2aCardAfterObj.card_data.files : [];
    assert(t2aFilesAfter.length === t2aBeforeCount + 1, `T2a expected files +1 (before=${t2aBeforeCount}, after=${t2aFilesAfter.length})`);

    const t2aFileIndex = t2aFilesAfter.findIndex((f) => String(f?.stored_name || '') === String(t2aUploadedFile?.stored_name || ''));
    assert(t2aFileIndex >= 0, 'T2a uploaded file metadata not found in card_data.files');

    const t2aDownloadRes = await httpMcpRaw('inspect.file-contents', {
      card_id: T2_FILE_CARD_ID,
      file_idx: t2aFileIndex,
    });
    assert(t2aDownloadRes.status === 200, `T2a file download returned ${t2aDownloadRes.status}`);
    const t2aDownloadedText = t2aDownloadRes.body.toString('utf-8');
    assert(t2aDownloadedText === t2aUploadText, 'T2a downloaded content mismatch');
    console.log('[T2a] ok: mcp-controlplane upload and mcp-raw download returned exact bytes');
  }

  // ── T3*: chat protocol over API + SSE ──
  {
    if (skipT3) {
      console.log('\n=== T3: skipped (--skip-t3) ===');
    } else {
      console.log(`\n[${new Date().toISOString()}] === T3: probe chat protocol (SSE lifecycle) ===`);
      const t3Dbg = (msg) => console.log(`[T3.DBG ${new Date().toISOString()}] ${msg}`);
      t3Dbg('step 1: creating chat SSE client');
      chatSseClientId = `chat-proto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      chatSseClient = startSseClient(`${BASE}/sse?clientId=${encodeURIComponent(chatSseClientId)}`, (payload) => {
        captureChatEvents(payload, CHAT_CARD_ID);
      });
      await new Promise((r) => setTimeout(r, 400));
      t3Dbg(`step 1: chat SSE client ready (clientId=${chatSseClientId})`);

      t3Dbg('step 2: subscribing chat SSE client');
      const subRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/subscribe-sse`, { clientId: chatSseClientId });
      t3Dbg(`step 2: subscribe returned status=${subRes.status}`);
      assert(subRes.status === 200, `chat subscribe returned ${subRes.status}`);

      t3Dbg('step 3: fetching pre-chat transcript');
      const t2Before = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
      t3Dbg(`step 3: pre-chat fetch returned status=${t2Before.status}`);
      assert(t2Before.status === 200, `T3 pre chats returned ${t2Before.status}`);
      const t2BeforeMessages = Array.isArray(t2Before.data?.messages) ? t2Before.data.messages : [];
      const t2BeforeCount = t2BeforeMessages.length;
      const t2EventStart = NS.chatEvents.length;
      const t2ProbePrompt = `Probe protocol validation ${Date.now()}`;
      t3Dbg(`step 3: beforeCount=${t2BeforeCount}, eventStart=${t2EventStart}`);

      const t3TurnId = randomTurnId();
      t3Dbg(`step 4: posting probe chat-send (turn-id=${t3TurnId})`);
      const t2SendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
        actionType: 'chat-send',
        payload: {
          text: `${ECHO_PROBE_MARKER}${t2ProbePrompt}${ECHO_PROBE_MARKER}`,
          'turn-id': t3TurnId,
        },
      });
      t3Dbg(`step 4: chat-send returned status=${t2SendRes.status}`);
      assert(t2SendRes.status === 200, `T3 chat-send returned ${t2SendRes.status}`);

      t3Dbg('step 5: waiting for ordered probe lifecycle on chat SSE');
      const t2Lifecycle = await waitForChatPredicate((events) => {
        return matchOrderedProbeLifecycle(events.slice(t2EventStart), {
          beforeCount: t2BeforeCount,
          beforeProcessing: false,
          prompt: t2ProbePrompt,
          inProgressText: PROBE_IN_PROGRESS_TEXT,
        });
      }, 45_000, 'T3 ordered lifecycle');
      t3Dbg('step 5: ordered lifecycle observed');
      assert(!!t2Lifecycle, 'T3 ordered lifecycle not observed');

      t3Dbg('step 6: fetching post-chat transcript');
      const t2After = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
      t3Dbg(`step 6: post-chat fetch returned status=${t2After.status}`);
      assert(t2After.status === 200, `T3 post chats returned ${t2After.status}`);
      const t2AfterMessages = Array.isArray(t2After.data?.messages) ? t2After.data.messages : [];
      const t2NewMessages = t2AfterMessages.slice(t2BeforeCount);
      t3Dbg(`step 6: validating ${t2NewMessages.length} new messages`);
      assert(t2NewMessages.length >= 3, `T3 expected at least 3 new chat messages, got ${t2NewMessages.length}`);
      const t3McpAfter = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, turn_id: t3TurnId });
      const t3McpAfterData = expectMcpSuccess(t3McpAfter, 'T3 MCP post chats');
      const t3TurnMessages = Array.isArray(t3McpAfterData?.messages) ? t3McpAfterData.messages : [];
      t3Dbg(`step 6: MCP turn messages count=${t3TurnMessages.length}`);
      assert(t3TurnMessages.length >= 3, `T3 expected at least 3 MCP messages for turn ${t3TurnId}, got ${t3TurnMessages.length}`);
      for (const msg of t3TurnMessages) {
        assert(String(msg?.turn || '') === t3TurnId, 'T3 MCP turn id mismatch');
      }
      const toComparableTurnMessage = (msg) => ({
        id: String(msg?.id || ''),
        role: String(msg?.role || ''),
        text: String(msg?.text || ''),
      });
      const t3HttpComparable = t2NewMessages.map(toComparableTurnMessage);
      const t3McpComparable = t3TurnMessages.map(toComparableTurnMessage);
      assert(JSON.stringify(t3HttpComparable) === JSON.stringify(t3McpComparable),
        `T3 HTTP /chats messages mismatch vs inspect.chat-messages-on-cards: http=${JSON.stringify(t3HttpComparable)} mcp=${JSON.stringify(t3McpComparable)}`);
      const t2User = t2NewMessages.find((m) => m?.role === 'user');
      const t2InProgress = t2NewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
      const t2AssistantMsg = t2NewMessages.find((m) => m?.role === 'assistant');
      assert(!!t2User && typeof t2User.id === 'string', 'T3 user chat message missing id');
      assert(String(t2User?.text || '').includes(t2ProbePrompt), 'T3 user file text mismatch');
      assert(!!t2InProgress && typeof t2InProgress.id === 'string', 'T3 in-progress system message missing id');
      assert(!!t2AssistantMsg && typeof t2AssistantMsg.id === 'string', 'T3 assistant chat message missing id');
      assert(String(t2AssistantMsg?.text || '').includes(`Echo: ${t2ProbePrompt}`), 'T3 assistant echo file content mismatch');
      t3Dbg('step 6: all assertions passed');
      console.log(`[${new Date().toISOString()}] [T3] ok: ordered probe lifecycle observed (user+processing, in-progress, assistant+processing clear)`);
    }

  // ── T3a: non-probe chat protocol over API + SSE ──
  // Disabled in the public example unless explicitly requested — requires a
  // configured Azure Foundry endpoint and agent_id in server-config.json.
  if (skipT3a) {
    console.log('\n=== T3a: skipped (--skip-t3a) ===');
  } else {
    console.log('\n=== T3a: non-probe chat protocol (expect paris) ===');
    const t3aDbg = (msg) => console.log(`[T3a.DBG ${new Date().toISOString()}] ${msg}`);
    t3aDbg('step 1: fetching pre-chat transcript');
    const t2aBefore = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    t3aDbg(`step 1: pre-chat fetch returned status=${t2aBefore.status}`);
    assert(t2aBefore.status === 200, `T3a pre chats returned ${t2aBefore.status}`);
    const t2aBeforeMessages = Array.isArray(t2aBefore.data?.messages) ? t2aBefore.data.messages : [];
    const t2aBeforeCount = t2aBeforeMessages.length;
    const t2aPrompt = 'Just answer what is the capital of France. No Fluff. No COmmentary.  No Markup Respond in lower case in one word.';
    t3aDbg(`step 1: beforeCount=${t2aBeforeCount}`);

    const t3aTurnId = randomTurnId();
    t3aDbg(`step 2: posting non-probe chat-send (turn-id=${t3aTurnId})`);
    const t2aSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
      actionType: 'chat-send',
      payload: {
        text: JSON.stringify({
          prompt: t2aPrompt,
          chatTimeoutMs: 180000,
        }),
        'turn-id': t3aTurnId,
      },
    });
    t3aDbg(`step 2: chat-send returned status=${t2aSendRes.status}`);
    assert(t2aSendRes.status === 200, `T3a chat-send returned ${t2aSendRes.status}`);

    t3aDbg('step 3: waiting for assistant message containing paris on chat SSE');
    const t2aAssistant = await waitForChatPredicate((events) => {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e.messageCount < t2aBeforeCount + 2) continue;
        const last = e.messages[e.messages.length - 1];
        if (last?.role === 'assistant' && /paris/i.test(String(last.text || ''))) return e;
      }
      return false;
    }, 240_000, 'T3a assistant response with paris');
    t3aDbg('step 3: assistant SSE event observed');
    assert(!!t2aAssistant, 'T3a assistant response with paris not observed on SSE');
    const t2aSseLast = t2aAssistant.messages[t2aAssistant.messages.length - 1];
    t3aDbg(`step 3: assistant SSE text=${JSON.stringify(String(t2aSseLast?.text || '').slice(0, 400))}`);

    t3aDbg('step 4: fetching post-chat transcript');
    const t2aAfter = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    t3aDbg(`step 4: post-chat fetch returned status=${t2aAfter.status}`);
    assert(t2aAfter.status === 200, `T3a post chats returned ${t2aAfter.status}`);
    const t2aAfterMessages = Array.isArray(t2aAfter.data?.messages) ? t2aAfter.data.messages : [];
    const t2aNewMessages = t2aAfterMessages.slice(t2aBeforeCount);
    t3aDbg(`step 4: validating ${t2aNewMessages.length} new messages`);
    assert(t2aNewMessages.length >= 2, `T3a expected at least 2 new chat messages, got ${t2aNewMessages.length}`);
    const t2aAssistantMsg = [...t2aNewMessages].reverse().find((m) => m?.role === 'assistant');
    assert(!!t2aAssistantMsg && typeof t2aAssistantMsg.id === 'string', 'T3a assistant chat message missing id');
    assert(/paris/i.test(String(t2aAssistantMsg?.text || '')), 'T3a assistant file content missing paris');
    t3aDbg('step 4: all assertions passed');
    console.log('[T3a] ok: non-probe response contains paris');
  }

  // ── T3b: probe-echo chat + file upload protocol over API + SSE ──
  if (skipT3b) {
    console.log('\n=== T3b: skipped (--skip-t3b) ===');
  } else {
    console.log('\n=== T3b: probe-echo chat with file upload protocol ===');
    const t2bBefore = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2bBefore.status === 200, `T3b pre chats returned ${t2bBefore.status}`);
    const t2bBeforeMessages = Array.isArray(t2bBefore.data?.messages) ? t2bBefore.data.messages : [];
    const t2bBeforeCount = t2bBeforeMessages.length;

    const t3bTurnId = randomTurnId();
    const t2bUploadRes = await httpUploadChatFile(
      `${BASE}/cards/${CHAT_CARD_ID}/files?inChat=true&turn-id=${encodeURIComponent(t3bTurnId)}`,
      'q1.txt',
      'tokyo',
    );
    assert(t2bUploadRes.status === 200, `T3b file upload returned ${t2bUploadRes.status}`);
    const uploadedFile = t2bUploadRes.data?.file;
    assert(uploadedFile && typeof uploadedFile === 'object', 'T3b upload response missing file metadata');

    const t2bAfterUpload = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2bAfterUpload.status === 200, `T3b chats after upload returned ${t2bAfterUpload.status}`);
    const t2bUploadMessages = Array.isArray(t2bAfterUpload.data?.messages) ? t2bAfterUpload.data.messages : [];
    const t2bUploadNewMessages = t2bUploadMessages.slice(t2bBeforeCount);
    const t2bUploadSystem = t2bUploadNewMessages.find((m) => m?.role === 'system');
    assert(!!t2bUploadSystem, 'T3b upload protocol missing system chat file');
    assert(String(t2bUploadSystem?.text || '').toLowerCase().includes('file uploaded:'), 'T3b upload system message does not describe uploaded file');

    const t2bCardAfterUpload = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}`);
    assert(t2bCardAfterUpload.status === 200, `T3b card read after upload returned ${t2bCardAfterUpload.status}`);
    const t2bFilesAfterUpload = Array.isArray(t2bCardAfterUpload.data?.card_data?.files)
      ? t2bCardAfterUpload.data.card_data.files
      : [];
    const t2bFileIndex = t2bFilesAfterUpload.findIndex((f) => String(f?.stored_name || '') === String(uploadedFile?.stored_name || ''));
    assert(t2bFileIndex >= 0, 'T3b uploaded file metadata not found in card_data.files');

    const t2bDownloadRes = await httpGetRaw(
      `${BASE}/cards/${CHAT_CARD_ID}/files/${t2bFileIndex}?sn=${encodeURIComponent(String(uploadedFile?.stored_name || ''))}`,
    );
    assert(t2bDownloadRes.status === 200, `T3b file download returned ${t2bDownloadRes.status}`);
    assert(t2bDownloadRes.body.toString('utf-8') === 'tokyo', 'T3b downloaded content mismatch');

    const t2bSendBaseline = t2bUploadMessages.length;
    const t2bEventStart = NS.chatEvents.length;

    const t2bPrompt = `probe echo file-upload validation ${Date.now()}`;
    const t2bSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
      actionType: 'chat-send',
      payload: {
        text: `${ECHO_PROBE_MARKER}${t2bPrompt}${ECHO_PROBE_MARKER}`,
        files: [uploadedFile],
        'turn-id': t3bTurnId,
      },
    });
    assert(t2bSendRes.status === 200, `T3b chat-send returned ${t2bSendRes.status}`);

    const t2bLifecycle = await waitForChatPredicate((events) => {
      return matchOrderedProbeLifecycle(events.slice(t2bEventStart), {
        beforeCount: t2bSendBaseline,
        beforeProcessing: false,
        prompt: t2bPrompt,
        assistantText: 'tokyo',
        inProgressText: PROBE_IN_PROGRESS_TEXT,
      });
    }, 60_000, 'T3b ordered lifecycle');
    assert(!!t2bLifecycle, 'T3b ordered lifecycle not observed');

    const t2bAfter = await httpGet(`${BASE}/cards/${CHAT_CARD_ID}/chats?all-turns=true`);
    assert(t2bAfter.status === 200, `T3b post chats returned ${t2bAfter.status}`);
    const t2bAfterMessages = Array.isArray(t2bAfter.data?.messages) ? t2bAfter.data.messages : [];
    const t2bNewMessages = t2bAfterMessages.slice(t2bSendBaseline);
    assert(t2bNewMessages.length >= 3, `T3b expected at least 3 chat messages after send, got ${t2bNewMessages.length}`);

    const t2bUser = t2bNewMessages.find((m) => m?.role === 'user');
    const t2bInProgress = t2bNewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
    const t2bAssistantMsg = t2bNewMessages.find((m) => m?.role === 'assistant');

    assert(!!t2bUser && typeof t2bUser.id === 'string', 'T3b missing user chat message notification');
    assert(!!t2bInProgress && typeof t2bInProgress.id === 'string', 'T3b missing in-progress system chat message');
    assert(!!t2bAssistantMsg && typeof t2bAssistantMsg.id === 'string', 'T3b missing assistant chat message notification');
    assert(Array.isArray(t2bUser?.files) && t2bUser.files.length === 1, 'T3b user chat message missing uploaded file metadata');
    assert(String(t2bAssistantMsg?.text || '').trim() === 'tokyo', 'T3b assistant attachment content mismatch');
    console.log('[T3b] ok: upload protocol and ordered probe lifecycle observed with attachment-derived assistant reply');
  }

  if (skipT4) {
    console.log('\n=== T4: skipped (--skip-t4) ===');
  } else {
    console.log('\n=== T4: preflight MCP smoke checks ===');

    const discoverSourceKindsData = expectMcpSuccess(
      await httpMcp('discover.source-kinds', {}),
      'T4 discover.source-kinds',
    );
    assert(discoverSourceKindsData && typeof discoverSourceKindsData === 'object', 'T4 discover.source-kinds missing payload');
    assert(discoverSourceKindsData.sourceKinds && typeof discoverSourceKindsData.sourceKinds === 'object', 'T4 discover.source-kinds missing sourceKinds');
    const discoveredSourceKinds = Object.keys(discoverSourceKindsData.sourceKinds).sort();
    assert(
      JSON.stringify(discoveredSourceKinds) === JSON.stringify(['mock', 'sqlite', 'urls']),
      `T4 discover.source-kinds mismatch: ${JSON.stringify(discoveredSourceKinds)}`,
    );
    console.log('[T4.discover] ok: source kinds match demo task executor');

    const getCardDefinition = (fileName) => {
      const filePath = path.join(BOARD_DIR, 'cards', fileName);
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    };

    const expectPreflightSuccess = (res, label) => {
      assert(res.status === 200, `${label} returned ${res.status}`);
      assert(res.data?.status === 'success', `${label} expected status=success, got ${JSON.stringify(res.data)}`);
      assert(res.data?.data && typeof res.data.data === 'object', `${label} missing success data`);
      return res.data.data;
    };

    const portfolioCard = getCardDefinition('cardT-portfolio.json');
    const marketCard = getCardDefinition('cardT-market-prices.json');
    const portfolioValueCard = getCardDefinition('cardT-portfolio-value.json');
    const baseHoldings = Array.isArray(portfolioCard?.card_data?.holdings) ? deepCloneJson(portfolioCard.card_data.holdings) : [];

    const mockQuotes = {
      quoteResponse: {
        result: [
          { symbol: 'AAPL', shortName: 'Apple Inc.', regularMarketPrice: 198.15, regularMarketChange: 2.15, regularMarketChangePercent: 1.10 },
          { symbol: 'MSFT', shortName: 'Microsoft Corp.', regularMarketPrice: 415.32, regularMarketChange: -1.23, regularMarketChangePercent: -0.30 },
          { symbol: 'GOOGL', shortName: 'Alphabet Inc.', regularMarketPrice: 174.89, regularMarketChange: 0.89, regularMarketChangePercent: 0.51 },
          { symbol: 'TSLA', shortName: 'Tesla Inc.', regularMarketPrice: 247.12, regularMarketChange: 5.43, regularMarketChangePercent: 2.25 },
        ],
        error: null,
      },
    };

    const makePortfolioVariant = (id, extraHolding) => {
      const card = deepCloneJson(portfolioCard);
      card.id = id;
      card.card_data.holdings = [...baseHoldings, extraHolding];
      return card;
    };

    const makeMockSourceCard = ({ id, bindTo = 'quotes', secondBindTo = null, includeProjection = false, projectionExpr = '"ok"', missingMock = false }) => {
      const card = deepCloneJson(marketCard);
      card.id = id;
      card.requires = [];
      card.source_defs = [
        { bindTo, mock: missingMock ? 'missing-mock-key' : 'quotes' },
        ...(secondBindTo ? [{ bindTo: secondBindTo, mock: 'quotes' }] : []),
      ];
      if (includeProjection) {
        card.source_defs[0].projections = { passthrough: projectionExpr };
      } else {
        delete card.source_defs[0].projections;
      }
      delete card.source_defs[0].urls;
      if (card.source_defs[1]) delete card.source_defs[1].urls;
      return card;
    };

    const portfolioVariantA = makePortfolioVariant('card-portfolio-preflight-a', { ticker: 'NVDA', quantity: 7, cost_basis: 121 });
    const portfolioVariantB = makePortfolioVariant('card-portfolio-preflight-b', { ticker: 'AMD', quantity: 9, cost_basis: 143 });
    const marketMockSourceCardA = makeMockSourceCard({ id: 'card-market-prices-preflight-source-a' });
    const marketMockSourceCardB = makeMockSourceCard({ id: 'card-market-prices-preflight-source-b', includeProjection: true });
    const marketMockSourceCardC = makeMockSourceCard({ id: 'card-market-prices-preflight-source-c', secondBindTo: 'quotesBackup' });
    const marketMockSourceCardD = makeMockSourceCard({ id: 'card-market-prices-preflight-source-d', bindTo: 'quotesPrimary' });
    const marketMockSourceCardE = makeMockSourceCard({ id: 'card-market-prices-preflight-source-e', bindTo: 'quotesEcho' });
    const marketMissingMockCard = makeMockSourceCard({ id: 'card-market-prices-preflight-missing', missingMock: true });
    const invalidCard = {
      ...deepCloneJson(marketCard),
      id: '',
      source_defs: [{ bindTo: '', mock: 'quotes' }],
      view: { layout: { kind: 'stack' }, elements: [{ id: 'broken' }] },
    };

    const validateSuccessCases = [
      { name: 'portfolio live', card: portfolioCard, expectCardId: 'card-portfolio' },
      { name: 'market live', card: marketCard, expectCardId: 'card-market-prices' },
      { name: 'portfolio-value live', card: portfolioValueCard, expectCardId: 'card-portfolio-value' },
      { name: 'portfolio variant', card: portfolioVariantA, expectCardId: 'card-portfolio-preflight-a' },
      { name: 'portfolio variant B', card: portfolioVariantB, expectCardId: 'card-portfolio-preflight-b' },
    ];
    for (const tc of validateSuccessCases) {
      const body = expectPreflightSuccess(await httpMcp('preflight.validate-candidate-card-definition', {
        candidate_card_content: tc.card,
      }), `T4 validate success (${tc.name})`);
      assert(body.cardId === tc.expectCardId, `T4 validate ${tc.name} cardId mismatch`);
      assert(body.isValid === true, `T4 validate ${tc.name} expected isValid=true`);
      assert(Array.isArray(body.issues) && body.issues.length === 0, `T4 validate ${tc.name} expected no issues`);
      console.log(`[T4.validate] ok: ${tc.name}`);
    }

    const validateFailureBody = expectPreflightSuccess(await httpMcp('preflight.validate-candidate-card-definition', {
      candidate_card_content: invalidCard,
    }), 'T4 validate failure (invalid card)');
    assert(validateFailureBody.isValid === false, 'T4 validate invalid card should be invalid');
    assert(Array.isArray(validateFailureBody.issues) && validateFailureBody.issues.length > 0, 'T4 validate invalid card should report issues');
    console.log('[T4.validate] ok: invalid card reports validation issues');

    const materializeSuccessCases = [
      {
        name: 'portfolio live empty mocks',
        card: portfolioCard,
        mockRequires: {},
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings), 'T4 materialize portfolio holdings missing');
          assert(body.provides_outputs.holdings.length === baseHoldings.length, 'T4 materialize portfolio holdings length mismatch');
          assert(body.rendered_view?.elements?.[0]?.kind === 'editable-table', 'T4 materialize portfolio rendered_view mismatch');
        },
      },
      {
        name: 'portfolio variant with extra holding',
        card: portfolioVariantA,
        mockRequires: {},
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings), 'T4 materialize portfolio variant holdings missing');
          assert(body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 materialize portfolio variant holdings length mismatch');
        },
      },
      {
        name: 'portfolio variant B with extra holding',
        card: portfolioVariantB,
        mockRequires: {},
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings), 'T4 materialize portfolio variant B holdings missing');
          assert(body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 materialize portfolio variant B holdings length mismatch');
        },
      },
      {
        name: 'portfolio-value live with mock requires',
        card: portfolioValueCard,
        mockRequires: { holdings: baseHoldings, quotes: mockQuotes },
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.computed_values?.positions) && body.computed_values.positions.length > 0, 'T4 materialize portfolio-value positions missing');
          assert(Array.isArray(body.provides_outputs?.positions) && body.provides_outputs.positions.length > 0, 'T4 materialize portfolio-value provides missing');
          assert(body.rendered_view?.elements?.length === 3, 'T4 materialize portfolio-value rendered_view length mismatch');
        },
      },
      {
        name: 'portfolio-value subset requires',
        card: portfolioValueCard,
        mockRequires: {
          holdings: baseHoldings.slice(0, 2),
          quotes: { quoteResponse: { result: mockQuotes.quoteResponse.result.slice(0, 2), error: null } },
        },
        mockFetchedSources: {},
        verify: (body) => {
          assert(Array.isArray(body.computed_values?.positions) && body.computed_values.positions.length === 2, 'T4 materialize portfolio-value subset positions mismatch');
          assert(Array.isArray(body.provides_outputs?.positions) && body.provides_outputs.positions.length === 2, 'T4 materialize portfolio-value subset provides mismatch');
        },
      },
    ];
    for (const tc of materializeSuccessCases) {
      const body = expectPreflightSuccess(await httpMcp('preflight.materialize-candidate-card', {
        candidate_card_content: tc.card,
        mock_requires: tc.mockRequires,
        mock_fetched_sources: tc.mockFetchedSources,
      }), `T4 materialize success (${tc.name})`);
      assert(body.ok === true, `T4 materialize ${tc.name} expected ok=true`);
      assert(Array.isArray(body.errors) && body.errors.length === 0, `T4 materialize ${tc.name} expected no errors`);
      tc.verify(body);
      console.log(`[T4.materialize] ok: ${tc.name}`);
    }

    const materializeFailureRes = await httpMcp('preflight.materialize-candidate-card', {
      candidate_card_content: portfolioCard,
    });
    assert(materializeFailureRes.status === 400, `T4 materialize missing args expected 400, got ${materializeFailureRes.status}`);
    assert(materializeFailureRes.data?.error === 'MCP tool requires mock_requires', 'T4 materialize missing args error mismatch');
    console.log('[T4.materialize] ok: missing required mocks is rejected');

    const probeSuccessCases = [
      { name: 'single mock source base', card: marketMockSourceCardA, sourceIdx: 0, bindTo: 'quotes', mockProjections: {} },
      { name: 'two mock sources first entry', card: marketMockSourceCardC, sourceIdx: 0, bindTo: 'quotes', mockProjections: {} },
      { name: 'two mock sources second entry', card: marketMockSourceCardC, sourceIdx: 1, bindTo: 'quotesBackup', mockProjections: {} },
      { name: 'single mock source alternate bindTo', card: marketMockSourceCardD, sourceIdx: 0, bindTo: 'quotesPrimary', mockProjections: {} },
    ];
    for (const tc of probeSuccessCases) {
      const body = expectPreflightSuccess(await httpMcp('preflight.probe-single-source-in-candidate-card', {
        candidate_card_content: tc.card,
        source_idx: tc.sourceIdx,
        mock_projections: tc.mockProjections,
      }), `T4 probe success (${tc.name})`);
      assert(body.bindTo === tc.bindTo, `T4 probe ${tc.name} bindTo mismatch`);
      assert(body.reachable === true, `T4 probe ${tc.name} expected reachable=true`);
      assert(typeof body.latencyMs === 'number', `T4 probe ${tc.name} expected numeric latencyMs`);
      console.log(`[T4.probe] ok: ${tc.name}`);
    }

    const probeFailureRes = await httpMcp('preflight.probe-single-source-in-candidate-card', {
      candidate_card_content: marketMissingMockCard,
      source_idx: 0,
      mock_projections: {},
    });
    assert(probeFailureRes.status === 400, `T4 probe failure expected 400, got ${probeFailureRes.status}`);
    assert(typeof probeFailureRes.data?.error === 'string' && probeFailureRes.data.error.length > 0, 'T4 probe failure expected error text');
    console.log('[T4.probe] ok: missing mock source returns HTTP error');

    const runSourceSuccessCases = [
      { name: 'single mock source base', card: marketMockSourceCardA, sourceIdx: 0, bindTo: 'quotes' },
      { name: 'two mock sources first entry', card: marketMockSourceCardC, sourceIdx: 0, bindTo: 'quotes' },
      { name: 'two mock sources second entry', card: marketMockSourceCardC, sourceIdx: 1, bindTo: 'quotesBackup' },
      { name: 'single mock source alternate bindTo', card: marketMockSourceCardE, sourceIdx: 0, bindTo: 'quotesEcho' },
    ];
    for (const tc of runSourceSuccessCases) {
      const body = expectPreflightSuccess(await httpMcp('preflight.run-single-source-in-candidate-card', {
        candidate_card_content: tc.card,
        source_idx: tc.sourceIdx,
        mock_projections: {},
      }), `T4 run-source success (${tc.name})`);
      assert(body.bindTo === tc.bindTo, `T4 run-source ${tc.name} bindTo mismatch`);
      assert(body.ok === true, `T4 run-source ${tc.name} expected ok=true`);
      assert(Array.isArray(body.issues) && body.issues.length === 0, `T4 run-source ${tc.name} expected no issues`);
      assert(Array.isArray(body.result?.quoteResponse?.result) && body.result.quoteResponse.result.length > 0, `T4 run-source ${tc.name} result shape mismatch`);
      console.log(`[T4.run-source] ok: ${tc.name}`);
    }

    const runSourceFailureBody = expectPreflightSuccess(await httpMcp('preflight.run-single-source-in-candidate-card', {
      candidate_card_content: marketMissingMockCard,
      source_idx: 0,
      mock_projections: {},
    }), 'T4 run-source failure (missing mock source)');
    assert(runSourceFailureBody.ok === false, 'T4 run-source missing mock should set ok=false');
    assert(Array.isArray(runSourceFailureBody.issues) && runSourceFailureBody.issues.length > 0, 'T4 run-source missing mock should report issues');
    console.log('[T4.run-source] ok: missing mock source returns ok=false with issues');

    const liveRunCardId = String(marketCard?.id || 'card-market-prices');

    const liveRunSourceBody = expectPreflightSuccess(await httpMcp('preflight.run-single-source-in-live-card', {
      card_id: liveRunCardId,
      source_idx: 0,
      mock_requires: { holdings: baseHoldings },
    }), 'T4 run-source live card success');
    assert(liveRunSourceBody.bindTo === 'quotes', 'T4 run-source live card bindTo mismatch');
    assert(liveRunSourceBody.ok === true, 'T4 run-source live card expected ok=true');
    assert(Array.isArray(liveRunSourceBody.issues) && liveRunSourceBody.issues.length === 0, 'T4 run-source live card expected no issues');
    assert(Array.isArray(liveRunSourceBody.result) && liveRunSourceBody.result.length === baseHoldings.length, 'T4 run-source live card result shape mismatch');
    console.log('[T4.run-source-live] ok: live card source run returns candidate-compatible shape');

    const liveRunRequiresBody = expectPreflightSuccess(await httpMcp('preflight.run-single-source-in-live-card', {
      card_id: liveRunCardId,
      source_idx: 0,
      mock_requires: { holdings: baseHoldings },
    }), 'T4 run-source live card uses mock_requires in projections');
    assert(liveRunRequiresBody.bindTo === 'quotes', 'T4 run-source live card requires bindTo mismatch');
    assert(liveRunRequiresBody.ok === true, 'T4 run-source live card requires expected ok=true');
    assert(Array.isArray(liveRunRequiresBody.issues) && liveRunRequiresBody.issues.length === 0, 'T4 run-source live card requires expected no issues');
    assert(Array.isArray(liveRunRequiresBody.result) && liveRunRequiresBody.result.length === baseHoldings.length, 'T4 run-source live card requires result shape mismatch');
    console.log('[T4.run-source-live] ok: non-empty mock_requires is consumed via source projections');

    const liveRunOutOfRangeRes = await httpMcp('preflight.run-single-source-in-live-card', {
      card_id: liveRunCardId,
      source_idx: 9,
      mock_requires: {},
    });
    assert(liveRunOutOfRangeRes.status === 400, `T4 run-source live card out-of-range expected 400, got ${liveRunOutOfRangeRes.status}`);
    assert(typeof liveRunOutOfRangeRes.data?.error === 'string' && liveRunOutOfRangeRes.data.error.length > 0, 'T4 run-source live card out-of-range expected error text');
    console.log('[T4.run-source-live] ok: out-of-range source_idx is rejected with HTTP error');

    const liveRunMissingMockRequiresRes = await httpMcp('preflight.run-single-source-in-live-card', {
      card_id: liveRunCardId,
      source_idx: 0,
    });
    assert(liveRunMissingMockRequiresRes.status === 400, `T4 run-source live card missing mock_requires expected 400, got ${liveRunMissingMockRequiresRes.status}`);
    assert(liveRunMissingMockRequiresRes.data?.error === 'MCP tool requires mock_requires', 'T4 run-source live card missing mock_requires error mismatch');
    console.log('[T4.run-source-live] ok: missing mock_requires is rejected');

    const runCycleSuccessCases = [
      {
        name: 'portfolio live',
        card: portfolioCard,
        mockRequires: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings) && body.provides_outputs.holdings.length === baseHoldings.length, 'T4 run-cycle portfolio provides mismatch');
          assert(body.rendered_view?.elements?.[0]?.kind === 'editable-table', 'T4 run-cycle portfolio rendered_view mismatch');
        },
      },
      {
        name: 'portfolio variant',
        card: portfolioVariantB,
        mockRequires: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings) && body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 run-cycle portfolio variant provides mismatch');
        },
      },
      {
        name: 'portfolio variant B',
        card: portfolioVariantB,
        mockRequires: {},
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.holdings) && body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 run-cycle portfolio variant B provides mismatch');
          assert(body.rendered_view?.elements?.[0]?.kind === 'editable-table', 'T4 run-cycle portfolio variant B rendered_view mismatch');
        },
      },
      {
        name: 'portfolio-value with full requires',
        card: portfolioValueCard,
        mockRequires: { holdings: baseHoldings, quotes: mockQuotes },
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.positions) && body.provides_outputs.positions.length > 0, 'T4 run-cycle portfolio-value provides mismatch');
          assert(body.rendered_view?.elements?.length === 3, 'T4 run-cycle portfolio-value rendered_view mismatch');
        },
      },
      {
        name: 'portfolio-value subset requires',
        card: portfolioValueCard,
        mockRequires: {
          holdings: baseHoldings.slice(0, 2),
          quotes: { quoteResponse: { result: mockQuotes.quoteResponse.result.slice(0, 2), error: null } },
        },
        verify: (body) => {
          assert(Array.isArray(body.provides_outputs?.positions) && body.provides_outputs.positions.length === 2, 'T4 run-cycle portfolio-value subset length mismatch');
        },
      },
      {
        name: 'market-prices with live source simulation',
        card: marketCard,
        mockRequires: { holdings: baseHoldings.slice(0, 3) },
        verify: (body) => {
          const quoteRows = body.provides_outputs?.quotes?.quoteResponse?.result;
          assert(Array.isArray(quoteRows) && quoteRows.length === 3, 'T4 run-cycle market-prices provides result length mismatch');
          assert(typeof quoteRows[0]?.symbol === 'string' && quoteRows[0].symbol.length > 0, 'T4 run-cycle market-prices provides symbol missing');

          const resolvedRows = body.rendered_view?.elements?.[0]?.resolved;
          assert(Array.isArray(resolvedRows) && resolvedRows.length === 3, 'T4 run-cycle market-prices rendered resolved length mismatch');
          assert(typeof resolvedRows[0]?.ticker === 'string' && resolvedRows[0].ticker.length > 0, 'T4 run-cycle market-prices rendered ticker missing');
          assert(typeof resolvedRows[0]?.price === 'number', 'T4 run-cycle market-prices rendered price missing');
        },
      },
    ];
    for (const tc of runCycleSuccessCases) {
      const body = expectPreflightSuccess(await httpMcp('preflight.run-one-cycle-with-candidate-card', {
        candidate_card_content: tc.card,
        mock_requires: tc.mockRequires,
      }), `T4 run-cycle success (${tc.name})`);
      assert(body.ok === true, `T4 run-cycle ${tc.name} expected ok=true`);
      assert(Array.isArray(body.issues) && body.issues.length === 0, `T4 run-cycle ${tc.name} expected no issues`);
      tc.verify(body);
      console.log(`[T4.run-cycle] ok: ${tc.name}`);
    }

    console.log('\n[T4.remove-card] testing manage.remove-card lifecycle');

    const T4_REMOVE_CARD_ID = 'card-t4-remove-test';
    const T4_REMOVE_CARD_V1 = {
      id: T4_REMOVE_CARD_ID,
      card_data: { label: 'v1', color: 'blue' },
    };
    const T4_REMOVE_CARD_V2 = {
      id: T4_REMOVE_CARD_ID,
      card_data: { label: 'v2', color: 'red' },
    };

    const t4UpsertV1Res = await httpMcp('manage.upsert-card', {
      card_id: T4_REMOVE_CARD_ID,
      candidate_card_content: T4_REMOVE_CARD_V1,
    });
    assert(t4UpsertV1Res.status === 200, `T4.remove-card v1 upsert returned ${t4UpsertV1Res.status}`);
    const t4UpsertV1Data = expectMcpSuccess(t4UpsertV1Res, 'T4.remove-card v1 upsert');
    assert(t4UpsertV1Data?.board_result?.status === 'success', 'T4.remove-card v1 upsert board_result expected success');
    console.log('[T4.remove-card] ok: v1 card upserted');

    const t4StatusBeforeRemove = expectMcpSuccess(
      await httpMcp('inspect.board-runtime-status', {}),
      'T4.remove-card board-runtime-status before remove',
    );
    const t4CardsBefore = Array.isArray(t4StatusBeforeRemove?.cards) ? t4StatusBeforeRemove.cards : [];
    assert(t4CardsBefore.some(c => c['card-id'] === T4_REMOVE_CARD_ID), 'T4.remove-card: card not found in board-runtime-status before remove');
    const t4CardCountBefore = t4StatusBeforeRemove?.summary?.card_count ?? 0;
    console.log(`[T4.remove-card] ok: board-runtime-status has ${t4CardCountBefore} cards before remove (includes ${T4_REMOVE_CARD_ID})`);

    const t4BoardEventsBefore = NS.boardEvents.length;
    const t4RemoveRes = await httpMcp('manage.remove-card', { card_id: T4_REMOVE_CARD_ID });
    assert(t4RemoveRes.status === 200, `T4.remove-card remove returned ${t4RemoveRes.status}`);
    const t4RemoveData = expectMcpSuccess(t4RemoveRes, 'T4.remove-card remove');
    assert(t4RemoveData?.board_result?.status === 'success', 'T4.remove-card board_result expected success');
    assert(t4RemoveData?.store_result?.status === 'success', 'T4.remove-card store_result expected success');
    console.log('[T4.remove-card] ok: manage.remove-card returned success for both board and store');

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const t4CardRemovedEvent = await waitUntil(
      () => NS.boardEvents.slice(t4BoardEventsBefore).find(e => e.kind === 'card_removed' && e.cardId === T4_REMOVE_CARD_ID) || false,
      10_000,
      `card_removed SSE notification for ${T4_REMOVE_CARD_ID}`,
    );
    assert(t4CardRemovedEvent && t4CardRemovedEvent.kind === 'card_removed', 'T4.remove-card: card_removed SSE event not received');
    assert(t4CardRemovedEvent.cardId === T4_REMOVE_CARD_ID, 'T4.remove-card: card_removed SSE cardId mismatch');
    console.log(`[T4.remove-card] ok: card_removed SSE notification received for ${T4_REMOVE_CARD_ID}`);

    const t4StatusAfterRemove = expectMcpSuccess(
      await httpMcp('inspect.board-runtime-status', {}),
      'T4.remove-card board-runtime-status after remove',
    );
    const t4CardsAfter = Array.isArray(t4StatusAfterRemove?.cards) ? t4StatusAfterRemove.cards : [];
    assert(!t4CardsAfter.some(c => c['card-id'] === T4_REMOVE_CARD_ID), 'T4.remove-card: card still present in board-runtime-status after remove');
    const t4CardCountAfter = t4StatusAfterRemove?.summary?.card_count ?? 0;
    assert(t4CardCountAfter === t4CardCountBefore - 1, `T4.remove-card: card_count expected ${t4CardCountBefore - 1}, got ${t4CardCountAfter}`);
    console.log(`[T4.remove-card] ok: card absent from board-runtime-status after remove (count: ${t4CardCountBefore} → ${t4CardCountAfter})`);

    const t4BoardEventsBeforeV2 = NS.boardEvents.length;
    const t4UpsertV2Res = await httpMcp('manage.upsert-card', {
      card_id: T4_REMOVE_CARD_ID,
      candidate_card_content: T4_REMOVE_CARD_V2,
    });
    assert(t4UpsertV2Res.status === 200, `T4.remove-card v2 upsert returned ${t4UpsertV2Res.status}`);
    const t4UpsertV2Data = expectMcpSuccess(t4UpsertV2Res, 'T4.remove-card v2 upsert');
    assert(t4UpsertV2Data?.board_result?.status === 'success', 'T4.remove-card v2 upsert board_result expected success');
    console.log('[T4.remove-card] ok: v2 card upserted under same id');

    const t4CardRefreshedEvent = await waitUntil(
      () => NS.boardEvents.slice(t4BoardEventsBeforeV2).find(e => e.kind === 'card_refreshed' && e.cardId === T4_REMOVE_CARD_ID) || false,
      10_000,
      `card_refreshed SSE notification for ${T4_REMOVE_CARD_ID} after v2 upsert`,
    );
    assert(t4CardRefreshedEvent && t4CardRefreshedEvent.kind === 'card_refreshed', 'T4.remove-card: card_refreshed SSE event not received after v2 upsert');
    console.log(`[T4.remove-card] ok: card_refreshed SSE notification received for v2 of ${T4_REMOVE_CARD_ID}`);

    await waitForAllCompleted(30_000, 'T4 remove-card re-upsert completion');

    const t4StatusAfterV2 = expectMcpSuccess(
      await httpMcp('inspect.board-runtime-status', {}),
      'T4.remove-card board-runtime-status after v2 upsert',
    );

    const t4CardsAfterV2 = Array.isArray(t4StatusAfterV2?.cards) ? t4StatusAfterV2.cards : [];
    assert(t4CardsAfterV2.some(c => c['card-id'] === T4_REMOVE_CARD_ID), 'T4.remove-card: v2 card missing from board-runtime-status');
    const t4CardCountAfterV2 = t4StatusAfterV2?.summary?.card_count ?? 0;
    assert(t4CardCountAfterV2 === t4CardCountBefore, `T4.remove-card: card_count after v2 upsert expected ${t4CardCountBefore}, got ${t4CardCountAfterV2}`);
    console.log('[T4.remove-card] ok: v2 card present in board-runtime-status');

    const t4InspectV2Data = expectMcpSuccess(
      await httpMcp('inspect.card-definition-and-runtime', { card_id: T4_REMOVE_CARD_ID }),
      'T4.remove-card inspect v2',
    );
    assert(t4InspectV2Data?.cardId === T4_REMOVE_CARD_ID, 'T4.remove-card inspect v2 cardId mismatch');
    const t4V2CardData = t4InspectV2Data?.card_definition_and_static_data?.card_data ?? null;
    assert(t4V2CardData?.label === 'v2', `T4.remove-card inspect v2 label expected "v2", got "${t4V2CardData?.label}"`);
    assert(t4V2CardData?.color === 'red', `T4.remove-card inspect v2 color expected "red", got "${t4V2CardData?.color}"`);
    console.log('[T4.remove-card] ok: inspect.card-definition-and-runtime reflects v2 card_data after re-upsert');

    await httpMcp('manage.remove-card', { card_id: T4_REMOVE_CARD_ID });
    console.log('[T4.remove-card] cleanup done');

  }

  if (skipT5) {
    console.log('\n=== T5: skipped (--skip-t5) ===');
  } else {
    console.log('\n=== T5: mcp-controlplane setstate/getstate ===');
    const T5_CARD_ID = CHAT_CARD_ID;

    const t5IsProcInit = expectMcpSuccess(
      await httpMcpControlplane('getstate.is-chat-processing', { board_id: BOARD_ID, card_id: T5_CARD_ID }),
      'T5 getstate.is-chat-processing initial',
    );
    assert(t5IsProcInit?.active === false, `T5 expected initial chat-processing=false, got ${JSON.stringify(t5IsProcInit)}`);

    expectMcpSuccess(
      await httpMcpControlplane('setstate.chat-processing-started', { board_id: BOARD_ID, card_id: T5_CARD_ID }),
      'T5 setstate.chat-processing-started',
    );
    const t5IsProcStarted = expectMcpSuccess(
      await httpMcpControlplane('getstate.is-chat-processing', { board_id: BOARD_ID, card_id: T5_CARD_ID }),
      'T5 getstate.is-chat-processing after start',
    );
    assert(t5IsProcStarted?.active === true, 'T5 expected chat-processing=true after setstate.chat-processing-started');

    expectMcpSuccess(
      await httpMcpControlplane('setstate.chat-processing-done', { board_id: BOARD_ID, card_id: T5_CARD_ID }),
      'T5 setstate.chat-processing-done',
    );
    const t5IsProcDone = expectMcpSuccess(
      await httpMcpControlplane('getstate.is-chat-processing', { board_id: BOARD_ID, card_id: T5_CARD_ID }),
      'T5 getstate.is-chat-processing after done',
    );
    assert(t5IsProcDone?.active === false, 'T5 expected chat-processing=false after setstate.chat-processing-done');
    console.log('[T5] ok: setstate/getstate chat-processing round-trip');

    const t5ThreadId = `thread-t5-${Date.now()}`;
    expectMcpSuccess(
      await httpMcpControlplane('setstate.card-meta', { board_id: BOARD_ID, card_id: T5_CARD_ID, key: 'chat.foundry_thread_id', value: t5ThreadId }),
      'T5 setstate.card-meta',
    );
    const t5GetMeta = expectMcpSuccess(
      await httpMcpControlplane('getstate.card-meta', { board_id: BOARD_ID, card_id: T5_CARD_ID, key: 'chat.foundry_thread_id' }),
      'T5 getstate.card-meta',
    );
    assert(t5GetMeta?.exists === true && t5GetMeta?.value === t5ThreadId, `T5 getstate.card-meta mismatch: ${JSON.stringify(t5GetMeta)}`);

    const t5ReadCards = expectMcpSuccess(
      await httpMcp('manage.read-card', { card_id: T5_CARD_ID }),
      'T5 manage.read-card meta-redaction',
    );
    const t5ReadCard = Array.isArray(t5ReadCards) ? t5ReadCards[0] : null;
    assert(t5ReadCard && t5ReadCard.meta === undefined, 'T5 expected manage.read-card to redact top-level meta');

    const t5Inspect = expectMcpSuccess(
      await httpMcp('inspect.card-definition-and-runtime', { card_id: T5_CARD_ID }),
      'T5 inspect.card-definition-and-runtime meta-redaction',
    );
    assert(t5Inspect?.card_definition_and_static_data?.meta === undefined, 'T5 expected inspect to redact card_definition_and_static_data.meta');
    console.log('[T5] ok: regular /mcp surfaces redact card meta');
  }
  }

  console.log('\n=== All smoke checks passed ===\n');
} finally {
  if (chatSseClientId) {
    try {
      await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/unsubscribe-sse`, { clientId: chatSseClientId });
    } catch { /* ignore */ }
  }
  if (chatSseClient) chatSseClient.close();
  await stopChildProcess(serverProc, 'demo board server');
  if (sseWorker) await sseWorker.terminate();

  // Clean up the test setup directory
  if (fs.existsSync(SETUP_DIR)) {
    fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  }
  console.log('[demo-http-test] server stopped, setup dir cleaned');
}
