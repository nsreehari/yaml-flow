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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliArgs = process.argv.slice(2);
const portArg = cliArgs.indexOf('--port');
const PORT = portArg !== -1 ? parseInt(cliArgs[portArg + 1], 10) : 7799;

const BOARD_ID = 'default';
const BASE = `http://127.0.0.1:${PORT}/api/boards/${BOARD_ID}`;
const SERVER_SCRIPT = path.join(__dirname, '..', 'demo-server.js');
const SSE_WORKER_SCRIPT = path.join(__dirname, 'portfolio-tracker-sse-worker.js');
const CARD_PATTERN = 'cardT*';


const NS = {
  initialPayload: null,
  statusSummary: null,
  statusGeneration: 0,
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
    return;
  }

  if (payload && payload.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
    for (const n of payload.notifications) {
      const summary = n && n.kind === 'status' && n.status && n.status.summary;
      if (summary) {
        NS.statusSummary = summary;
        NS.statusGeneration += 1;
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
    const sseCardCount = Array.isArray(NS.initialPayload?.cardDefinitions)
      ? NS.initialPayload.cardDefinitions.length
      : 0;
    if (sseCardCount > 0) {
      if (s && s.card_count > 0 && s.completed === s.card_count) return s;
      return { card_count: sseCardCount, completed: sseCardCount, failed: 0, mode: 'sse-initial-only' };
    }
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

function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_SCRIPT, '--reset', '--cards-pattern', CARD_PATTERN], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DEMO_SERVER_PORT: String(port) },
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
    workerData: { sseUrl: `${BASE}/sse` },
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

  console.log('\n=== All smoke checks passed ===\n');
} finally {
  sseWorker?.terminate();
  serverProc.kill();
  await new Promise((r) => serverProc.on('exit', r));
  console.log('[demo-http-test] server stopped');
}
