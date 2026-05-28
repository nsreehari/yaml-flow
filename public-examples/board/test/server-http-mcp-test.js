#!/usr/bin/env node
/**
        name: 'portfolio variant B',
        card: portfolioVariantB,
 * Smoke test for demo-board/server/board-server.js over HTTP + SSE.
 * Targets the 'live' board with --cards-pattern cardT* to load only the 3
          assert(Array.isArray(body.provides_outputs?.holdings) && body.provides_outputs.holdings.length === baseHoldings.length + 1, 'T4 run-cycle portfolio variant B provides mismatch');
          assert(body.rendered_view?.elements?.[0]?.kind === 'editable-table', 'T4 run-cycle portfolio variant B rendered_view mismatch');
 * T0: init-board -> SSE initial payload -> wait for all cards to complete
 * T1: mutate holdings in memory -> manage.upsert-card over MCP -> verify recomputation
 *
 * Usage:
 *   node test/server-http-mcp-test.js [--port 7799]
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

function resolveSetupDirRoot() {
  return os.tmpdir();
}

const SETUP_DIR = path.join(resolveSetupDirRoot(), RUN_ID);
const BOARD_SETUP_ROOT = path.join(SETUP_DIR, 'boards');
if (fs.existsSync(SETUP_DIR)) {
  fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  console.log(`[server-http-mcp-test] wiped setup dir: ${SETUP_DIR}`);
}

const NS = {
  initialPayload: null,
  statusSummary: null,
  statusGeneration: 0,
  computedValues: {},
  chatEvents: [],
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
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (!data) continue;
    try { payloads.push(JSON.parse(data)); } catch { /* ignore malformed */ }
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

const waitForInitialPayload = (ms = 15_000) => waitUntil(() => NS.initialPayload || false, ms, 'initial SSE payload');
const waitForAllCompleted = (ms = 60_000, label = 'all completed') => waitUntil(() => {
  const s = NS.statusSummary;
  if (s && s.card_count > 0 && s.completed === s.card_count) return s;
  return false;
}, ms, label);
const waitForChatPredicate = (predicate, ms, label) => waitUntil(() => predicate(NS.chatEvents) || false, ms, label);

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
    const newMessages = nextMessageCount > prevMessageCount ? messages.slice(prevMessageCount, nextMessageCount) : [];

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
        resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers });
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

    setTimeout(() => {
      if (!ready) reject(new Error('Server startup timeout (15s)'));
    }, 15_000);
  });
}

console.log('\n=== live board HTTP+SSE MCP smoke test ===');
console.log(`target: ${BASE}`);
console.log(`card pattern: ${CARD_PATTERN}`);

const serverProc = await startServer(PORT);
let sseWorker = null;
let chatSseClient = null;
let chatSseClientId = '';

try {
  const regRes = await httpJson('POST', `http://127.0.0.1:${PORT}/api/boards`, { id: BOARD_ID, label: 'Live' });
  assert(regRes.status === 200 || regRes.status === 201 || regRes.status === 409,
    `POST /api/boards returned ${regRes.status}: ${JSON.stringify(regRes.data)}`);
  console.log(`[setup] board '${BOARD_ID}' registered (${regRes.status})`);

  console.log('\n=== T0 Step 1: init-board ===');
  const initRes = await httpGet(`${BASE}/init-board`);
  assert(initRes.status === 200, `init-board returned ${initRes.status}`);
  console.log('[T0.1] init-board ok');

  console.log('\n=== T0 Step 2: start SSE worker ===');
  const sseClientId = `server-http-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sseUrl = `${BASE}/sse?clientId=${encodeURIComponent(sseClientId)}`;
  sseWorker = new Worker(SSE_WORKER_SCRIPT, { workerData: { sseUrl } });
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
  const statusRes = await httpMcp('inspect.board-runtime-status', {});
  const statusData = expectMcpSuccess(statusRes, 'inspect.board-runtime-status');
  const httpSummary = statusData?.summary;
  assert(httpSummary, 'statusSnapshot.summary missing from board-status');
  assert(httpSummary.completed === httpSummary.card_count, `not all complete: ${JSON.stringify(httpSummary)}`);
  console.log(`[T0.4] board-status: ${JSON.stringify(httpSummary)}`);

  const t0Positions = NS.computedValues['card-portfolio-value']?.positions;
  assert(Array.isArray(t0Positions) && t0Positions.length > 0, 'T0 positions missing from computed_values');
  console.log(`[T0] ok: ${t0Positions.length} positions computed`);

  if (skipT1) {
    console.log('\n=== T1: skipped (--skip-t1) ===');
  } else {
    console.log('\n=== T1: local mutation + manage.upsert-card (+1 row) ===');

    const portfolioCardRes = await httpMcp('inspect.card-definition-and-runtime', { card_id: 'card-portfolio' });
    const existingCard = expectMcpSuccess(portfolioCardRes, 'inspect.card-definition-and-runtime')?.card_definition_and_static_data ?? null;
    const existingHoldings = existingCard?.card_data?.holdings;
    assert(Array.isArray(existingHoldings), 'card-portfolio.card_data.holdings missing');
    const t0HoldingsCount = existingHoldings.length;
    const t0PositionsCount = t0Positions.length;

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
        ...(existingCard.card_data || {}),
        holdings: newHoldings,
      },
    };

    const upsertRes = await httpJson('POST', `${BASE}/mcp`, {
      tool: 'manage.upsert-card',
      args: {
        card_id: 'card-portfolio',
        candidate_card_content: nextCard,
      },
    });
    assert(upsertRes.status === 200, `manage.upsert-card returned ${upsertRes.status}`);
    assert(upsertRes.data?.status === 'success', `manage.upsert-card failed: ${JSON.stringify(upsertRes.data)}`);

    NS.statusSummary = null;
    await new Promise(r => setTimeout(r, 4000));
    const t1Summary = await waitForAllCompleted(30_000, 'T1 holdings upsert');
    assert(t1Summary.failed === 0, `T1 failed=${t1Summary.failed}`);

    const t1PortfolioRes = await httpMcp('inspect.card-definition-and-runtime', { card_id: 'card-portfolio' });
    const afterCard = expectMcpSuccess(t1PortfolioRes, 'inspect.card-definition-and-runtime after upsert')?.card_definition_and_static_data ?? null;
    const afterHoldings = afterCard?.card_data?.holdings;
    const afterHoldingsCount = Array.isArray(afterHoldings) ? afterHoldings.length : 0;

    const afterPositions = NS.computedValues['card-portfolio-value']?.positions;
    const afterPositionsCount = Array.isArray(afterPositions) ? afterPositions.length : 0;

    assert(afterHoldingsCount === t0HoldingsCount + 1,
      `Expected holdings rows +1 (before=${t0HoldingsCount}, after=${afterHoldingsCount})`);
    assert(afterPositionsCount === t0PositionsCount + 1,
      `Expected positions rows +1 (before=${t0PositionsCount}, after=${afterPositionsCount})`);
    console.log(`[T1] ok: holdings ${t0HoldingsCount}->${afterHoldingsCount}, ` +
      `positions ${t0PositionsCount}->${afterPositionsCount}, added=${newTicker}`);
  }

  if (skipT2) {
    console.log('\n=== T2: skipped (--skip-t2) ===');
  } else {
    console.log('\n=== T2: plain file upload -> card_data.files -> download ===');
    const t2CardBefore = await httpMcp('manage.read-card', { card_id: T2_FILE_CARD_ID });
    const t2CardBeforeData = expectMcpSuccess(t2CardBefore, 'T2 pre card read');
    const t2CardBeforeObj = Array.isArray(t2CardBeforeData) ? t2CardBeforeData[0] : null;
    const t2FilesBefore = Array.isArray(t2CardBeforeObj?.card_data?.files) ? t2CardBeforeObj.card_data.files : [];
    const t2BeforeCount = t2FilesBefore.length;

    const t2UploadText = `plain-file-upload-${Date.now()}`;
    const t2UploadName = 't2-upload.txt';
    const t2UploadRes = await httpMcp('manage.upload-card-file', {
      card_id: T2_FILE_CARD_ID,
      file_name: t2UploadName,
      content_type: 'text/plain; charset=utf-8',
      text: t2UploadText,
    });
    const t2UploadData = expectMcpSuccess(t2UploadRes, 'T2 file upload');
    const t2UploadedFile = t2UploadData?.file;
    assert(t2UploadedFile && typeof t2UploadedFile === 'object', 'T2 upload response missing file metadata');
    assert(String(t2UploadedFile?.name || '') === t2UploadName, 'T2 uploaded file name mismatch');

    const t2CardAfter = await httpMcp('manage.read-card', { card_id: T2_FILE_CARD_ID });
    const t2CardAfterData = expectMcpSuccess(t2CardAfter, 'T2 post card read');
    const t2CardAfterObj = Array.isArray(t2CardAfterData) ? t2CardAfterData[0] : null;
    const t2FilesAfter = Array.isArray(t2CardAfterObj?.card_data?.files) ? t2CardAfterObj.card_data.files : [];
    assert(t2FilesAfter.length === t2BeforeCount + 1, `T2 expected files +1 (before=${t2BeforeCount}, after=${t2FilesAfter.length})`);

    const t2FileIndex = t2FilesAfter.findIndex((f) => String(f?.stored_name || '') === String(t2UploadedFile?.stored_name || ''));
    assert(t2FileIndex >= 0, 'T2 uploaded file metadata not found in card_data.files');

    const t2DownloadRes = await httpMcpRaw('inspect.file-contents', {
      card_id: T2_FILE_CARD_ID,
      file_idx: t2FileIndex,
    });
    assert(t2DownloadRes.status === 200, `T2 file download returned ${t2DownloadRes.status}`);
    const t2DownloadedText = t2DownloadRes.body.toString('utf-8');
    assert(t2DownloadedText === t2UploadText, 'T2 downloaded content mismatch');
    console.log('[T2] ok: card_data.files updated and file download endpoint returned exact bytes');
  }

  {
    if (skipT3) {
      console.log('\n=== T3: skipped (--skip-t3) ===');
    } else {
      console.log(`\n[${new Date().toISOString()}] === T3: probe chat protocol (SSE lifecycle) ===`);
      chatSseClientId = `chat-proto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      chatSseClient = startSseClient(`${BASE}/sse?clientId=${encodeURIComponent(chatSseClientId)}`, (payload) => {
        captureChatEvents(payload, CHAT_CARD_ID);
      });
      await new Promise((r) => setTimeout(r, 400));

      const subRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/subscribe-sse`, { clientId: chatSseClientId });
      assert(subRes.status === 200, `chat subscribe returned ${subRes.status}`);

      const t3Before = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, 'all-turns': true });
      const t3BeforeData = expectMcpSuccess(t3Before, 'T3 MCP pre chats');
      const t3BeforeMessages = Array.isArray(t3BeforeData?.messages) ? t3BeforeData.messages : [];
      const t3BeforeCount = t3BeforeMessages.length;
      const t3EventStart = NS.chatEvents.length;
      const t3ProbePrompt = `Probe protocol validation ${Date.now()}`;
      const t3TurnId = randomTurnId();

      const t3SendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
        actionType: 'chat-send',
        payload: {
          text: `${ECHO_PROBE_MARKER}${t3ProbePrompt}${ECHO_PROBE_MARKER}`,
          'turn-id': t3TurnId,
        },
      });
      assert(t3SendRes.status === 200, `T3 chat-send returned ${t3SendRes.status}`);

      const t3Lifecycle = await waitForChatPredicate((events) => {
        return matchOrderedProbeLifecycle(events.slice(t3EventStart), {
          beforeCount: t3BeforeCount,
          beforeProcessing: false,
          prompt: t3ProbePrompt,
          inProgressText: PROBE_IN_PROGRESS_TEXT,
        });
      }, 45_000, 'T3 ordered lifecycle');
      assert(!!t3Lifecycle, 'T3 ordered lifecycle not observed');

      const t3After = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, 'all-turns': true });
      const t3AfterData = expectMcpSuccess(t3After, 'T3 MCP post chats');
      const t3AfterMessages = Array.isArray(t3AfterData?.messages) ? t3AfterData.messages : [];
      const t3NewMessages = t3AfterMessages.slice(t3BeforeCount);
      assert(t3NewMessages.length >= 3, `T3 expected at least 3 new chat messages, got ${t3NewMessages.length}`);
      const t3User = t3NewMessages.find((m) => m?.role === 'user');
      const t3InProgress = t3NewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
      const t3AssistantMsg = t3NewMessages.find((m) => m?.role === 'assistant');
      assert(!!t3User && typeof t3User.id === 'string', 'T3 user chat message missing id');
      assert(String(t3User?.text || '').includes(t3ProbePrompt), 'T3 user file text mismatch');
      assert(String(t3User?.turn || '') === t3TurnId, 'T3 user turn id mismatch');
      assert(!!t3InProgress && typeof t3InProgress.id === 'string', 'T3 in-progress system message missing id');
      assert(String(t3InProgress?.turn || '') === t3TurnId, 'T3 in-progress system turn id mismatch');
      assert(!!t3AssistantMsg && typeof t3AssistantMsg.id === 'string', 'T3 assistant chat message missing id');
      assert(String(t3AssistantMsg?.text || '').includes(`Echo: ${t3ProbePrompt}`), 'T3 assistant echo file content mismatch');
      assert(String(t3AssistantMsg?.turn || '') === t3TurnId, 'T3 assistant turn id mismatch');
      console.log(`[${new Date().toISOString()}] [T3] ok: ordered probe lifecycle observed (user+processing, in-progress, assistant+processing clear)`);
    }

    if (skipT3a) {
      console.log('\n=== T3a: skipped (--skip-t3a) ===');
    } else {
      console.log('\n=== T3a: non-probe chat protocol (expect paris) ===');
      const t3aBefore = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, 'all-turns': true });
      const t3aBeforeData = expectMcpSuccess(t3aBefore, 'T3a MCP pre chats');
      const t3aBeforeMessages = Array.isArray(t3aBeforeData?.messages) ? t3aBeforeData.messages : [];
      const t3aBeforeCount = t3aBeforeMessages.length;
      const t3aPrompt = 'Just answer what is the capital of France. No Fluff. No COmmentary.  No Markup Respond in lower case in one word.';
      const t3aTurnId = randomTurnId();

      const t3aSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
        actionType: 'chat-send',
        payload: {
          'turn-id': t3aTurnId,
          text: JSON.stringify({
            prompt: t3aPrompt,
            chatTimeoutMs: 180000,
          }),
        },
      });
      assert(t3aSendRes.status === 200, `T3a chat-send returned ${t3aSendRes.status}`);

      const t3aAssistant = await waitForChatPredicate((events) => {
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const e = events[i];
          if (e.messageCount < t3aBeforeCount + 2) continue;
          const last = e.messages[e.messages.length - 1];
          if (last?.role === 'assistant' && /paris/i.test(String(last.text || ''))) return e;
        }
        return false;
      }, 240_000, 'T3a assistant response with paris');
      assert(!!t3aAssistant, 'T3a assistant response with paris not observed on SSE');

      const t3aAfter = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, 'all-turns': true });
      const t3aAfterData = expectMcpSuccess(t3aAfter, 'T3a MCP post chats');
      const t3aAfterMessages = Array.isArray(t3aAfterData?.messages) ? t3aAfterData.messages : [];
      const t3aNewMessages = t3aAfterMessages.slice(t3aBeforeCount);
      assert(t3aNewMessages.length >= 2, `T3a expected at least 2 new chat messages, got ${t3aNewMessages.length}`);
      const t3aUser = t3aNewMessages.find((m) => m?.role === 'user');
      const t3aAssistantMsg = [...t3aNewMessages].reverse().find((m) => m?.role === 'assistant');
      assert(!!t3aUser && typeof t3aUser.id === 'string', 'T3a user chat message missing id');
      assert(String(t3aUser?.turn || '') === t3aTurnId, 'T3a user turn id mismatch');
      assert(!!t3aAssistantMsg && typeof t3aAssistantMsg.id === 'string', 'T3a assistant chat message missing id');
      assert(/paris/i.test(String(t3aAssistantMsg?.text || '')), 'T3a assistant file content missing paris');
      assert(String(t3aAssistantMsg?.turn || '') === t3aTurnId, 'T3a assistant turn id mismatch');
      for (const msg of t3aNewMessages.filter((m) => m?.role === 'system')) {
        assert(String(msg?.turn || '') === t3aTurnId, 'T3a system turn id mismatch');
      }
      console.log('[T3a] ok: non-probe response contains paris');
    }

    if (skipT3b) {
      console.log('\n=== T3b: skipped (--skip-t3b) ===');
    } else {
      console.log('\n=== T3b: probe-echo chat with file upload protocol ===');
      const t3bBefore = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, 'all-turns': true });
      const t3bBeforeData = expectMcpSuccess(t3bBefore, 'T3b MCP pre chats');
      const t3bBeforeMessages = Array.isArray(t3bBeforeData?.messages) ? t3bBeforeData.messages : [];
      const t3bBeforeCount = t3bBeforeMessages.length;
      const t3bTurnId = randomTurnId();

      const t3bUploadRes = await httpUploadChatFile(
        `${BASE}/cards/${CHAT_CARD_ID}/files?inChat=true&turn-id=${encodeURIComponent(t3bTurnId)}`,
        'q1.txt',
        'tokyo',
      );
      assert(t3bUploadRes.status === 200, `T3b file upload returned ${t3bUploadRes.status}`);
      const uploadedFile = t3bUploadRes.data?.file;
      assert(uploadedFile && typeof uploadedFile === 'object', 'T3b upload response missing file metadata');

      const t3bAfterUpload = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, 'all-turns': true });
      const t3bAfterUploadData = expectMcpSuccess(t3bAfterUpload, 'T3b MCP chats after upload');
      const t3bUploadMessages = Array.isArray(t3bAfterUploadData?.messages) ? t3bAfterUploadData.messages : [];
      const t3bUploadNewMessages = t3bUploadMessages.slice(t3bBeforeCount);
      const t3bUploadSystem = t3bUploadNewMessages.find((m) => m?.role === 'system');
      assert(!!t3bUploadSystem, 'T3b upload protocol missing system chat file');
      assert(String(t3bUploadSystem?.text || '').toLowerCase().includes('file uploaded:'), 'T3b upload system message does not describe uploaded file');
      assert(String(t3bUploadSystem?.turn || '') === t3bTurnId, 'T3b upload system turn id mismatch');

      const t3bCardAfterUpload = await httpMcp('manage.read-card', { card_id: CHAT_CARD_ID });
      const t3bCardAfterUploadData = expectMcpSuccess(t3bCardAfterUpload, 'T3b manage.read-card after upload');
      const t3bCardAfterUploadValue = Array.isArray(t3bCardAfterUploadData) ? t3bCardAfterUploadData[0] : null;
      const t3bFilesAfterUpload = Array.isArray(t3bCardAfterUploadValue?.card_data?.files)
        ? t3bCardAfterUploadValue.card_data.files
        : [];
      const t3bFileIndex = t3bFilesAfterUpload.findIndex((f) => String(f?.stored_name || '') === String(uploadedFile?.stored_name || ''));
      assert(t3bFileIndex >= 0, 'T3b uploaded file metadata not found in card_data.files');

      const t3bDownloadRes = await httpMcpRaw('inspect.file-contents', {
        card_id: CHAT_CARD_ID,
        file_idx: t3bFileIndex,
      });
      assert(t3bDownloadRes.status === 200, `T3b file download returned ${t3bDownloadRes.status}`);
      assert(t3bDownloadRes.body.toString('utf-8') === 'tokyo', 'T3b downloaded content mismatch');

      const t3bSendBaseline = t3bUploadMessages.length;
      const t3bEventStart = NS.chatEvents.length;

      const t3bPrompt = `probe echo file-upload validation ${Date.now()}`;
      const t3bSendRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/actions`, {
        actionType: 'chat-send',
        payload: {
          'turn-id': t3bTurnId,
          text: `${ECHO_PROBE_MARKER}${t3bPrompt}${ECHO_PROBE_MARKER}`,
          files: [uploadedFile],
        },
      });
      assert(t3bSendRes.status === 200, `T3b chat-send returned ${t3bSendRes.status}`);

      const t3bLifecycle = await waitForChatPredicate((events) => {
        return matchOrderedProbeLifecycle(events.slice(t3bEventStart), {
          beforeCount: t3bSendBaseline,
          beforeProcessing: false,
          prompt: t3bPrompt,
          assistantText: 'tokyo',
          inProgressText: PROBE_IN_PROGRESS_TEXT,
        });
      }, 60_000, 'T3b ordered lifecycle');
      assert(!!t3bLifecycle, 'T3b ordered lifecycle not observed');

      const t3bAfter = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, 'all-turns': true });
      const t3bAfterData = expectMcpSuccess(t3bAfter, 'T3b MCP post chats');
      const t3bAfterMessages = Array.isArray(t3bAfterData?.messages) ? t3bAfterData.messages : [];
      const t3bNewMessages = t3bAfterMessages.slice(t3bSendBaseline);
      assert(t3bNewMessages.length >= 3, `T3b expected at least 3 chat messages after send, got ${t3bNewMessages.length}`);

      const t3bUser = t3bNewMessages.find((m) => m?.role === 'user');
      const t3bInProgress = t3bNewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
      const t3bAssistantMsg = t3bNewMessages.find((m) => m?.role === 'assistant');

      assert(!!t3bUser && typeof t3bUser.id === 'string', 'T3b missing user chat message notification');
      assert(String(t3bUser?.turn || '') === t3bTurnId, 'T3b user turn id mismatch');
      assert(!!t3bInProgress && typeof t3bInProgress.id === 'string', 'T3b missing in-progress system chat message');
      assert(String(t3bInProgress?.turn || '') === t3bTurnId, 'T3b in-progress system turn id mismatch');
      assert(!!t3bAssistantMsg && typeof t3bAssistantMsg.id === 'string', 'T3b missing assistant chat message notification');
      assert(Array.isArray(t3bUser?.files) && t3bUser.files.length === 1, 'T3b user chat message missing uploaded file metadata');
      assert(String(t3bAssistantMsg?.text || '').trim() === 'tokyo', 'T3b assistant attachment content mismatch');
      assert(String(t3bAssistantMsg?.turn || '') === t3bTurnId, 'T3b assistant turn id mismatch');
      console.log('[T3b] ok: upload protocol and ordered probe lifecycle observed with attachment-derived assistant reply');
    }
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
    const marketMockCycleCard = makeMockSourceCard({ id: 'card-market-prices-preflight-cycle' });
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
      { name: 'single mock source with projection payload', card: marketMockSourceCardB, sourceIdx: 0, bindTo: 'quotes', mockProjections: { passthrough: 'ok' } },
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
      { name: 'single mock source with projection payload', card: marketMockSourceCardB, sourceIdx: 0, bindTo: 'quotes' },
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

  }

  console.log('\n=== All smoke checks passed ===\n');
} finally {
  if (chatSseClientId) {
    try {
      await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/unsubscribe-sse`, { clientId: chatSseClientId });
    } catch { /* ignore */ }
  }
  if (chatSseClient) chatSseClient.close();
  serverProc.kill();
  await new Promise((r) => serverProc.on('exit', r));
  if (sseWorker) await sseWorker.terminate();

  if (fs.existsSync(SETUP_DIR)) {
    fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  }
  console.log('[server-http-mcp-test] server stopped, setup dir cleaned');
}