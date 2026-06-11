#!/usr/bin/env node
// @ts-nocheck
/**
 * demo-http-test-browser.ts
 *
 * Smoke test for demo-board/server/board-server.js over HTTP + SSE.
 * Uses yaml-flow's shared browser board-state reducer for SSE accumulation
 * instead of stitching incremental notification state inside the test.
 * Targets the 'live' board with --cards-pattern cardT* to load only the 3
 * test cards (cardT-portfolio, cardT-market-prices, cardT-portfolio-value).
 *
 * T0: /sse streaming connect → upsert fixtures → wait for all cards to complete
 * T1: PATCH holdings (+1 row) → verify recomputation (holdings +1, positions +1)
 *
 * Usage:
 *   npx tsx test/server-http-test-browser.ts [--port 7799]
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { buildBoardState, applyNotification } from '../../../src/board-state-reducer.ts';
import { runtimeNotificationsFromPayload } from '../../../src/notification-consumer/index.ts';

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
const skipT3e = cliArgs.includes('--skip-t3e');
const skipT3d = cliArgs.includes('--skip-t3d');
const RUN_ID = `run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

const BOARD_ID = 'live';
const BOARD_DIR = path.resolve(__dirname, '..');
const SERVER_SCRIPT = path.resolve(BOARD_DIR, 'server', 'board-server.js');
// Force the board server to start with zero cards; the test upserts the
// three cardT-* fixtures itself in T0 so the SSE upsert/delta path is
// exercised end-to-end.
const CARD_PATTERN = '__none__*';
const CARDS_DIR = path.resolve(BOARD_DIR, 'cards');
const T0_CARD_FILES = [
  'cardT-portfolio.json',
  'cardT-market-prices.json',
  'cardT-portfolio-value.json',
];
const T0_EXPECTED_CARD_IDS = ['card-market-prices', 'card-portfolio', 'card-portfolio-value'];
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
  boardState: null,
  latestFullPayload: null,
  statusSummary: null,
  statusGeneration: 0,
  computedValues: {},
  chatEvents: [],
  allChatNotifications: [],
  boardEvents: [],
};

function normalizeRequiredTokens(requires) {
  if (!Array.isArray(requires)) return [];
  return requires.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim()];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const bindTo = typeof entry.bindTo === 'string'
      ? entry.bindTo.trim()
      : typeof entry.key === 'string'
        ? entry.key.trim()
        : '';
    return bindTo ? [bindTo] : [];
  });
}

function normalizeChatState(chatSnapshot = null) {
  return {
    messages: Array.isArray(chatSnapshot?.messages) ? chatSnapshot.messages : [],
    receiving: chatSnapshot?.receiving === true,
    processing: chatSnapshot?.processing === true,
  };
}

function buildStatusCardIndex(statusSnapshot) {
  const index = new Map();
  for (const entry of (statusSnapshot?.cards ?? [])) {
    const cardId = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (cardId) index.set(cardId, entry);
  }
  return index;
}

function summarizeBoardState(boardState) {
  const summary = {
    card_count: Array.isArray(boardState?.cardIds) ? boardState.cardIds.length : 0,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
  };
  for (const cardId of (boardState?.cardIds ?? [])) {
    const taskStatus = String(boardState?.modelsById?.[cardId]?.runtime_state?.task_status || '');
    if (taskStatus === 'completed') summary.completed += 1;
    else if (taskStatus === 'failed') summary.failed += 1;
    else if (taskStatus === 'running' || taskStatus === 'in-progress') summary.running += 1;
    else summary.pending += 1;
  }
  return summary;
}

function syncProjectedStateFromBoardState() {
  if (!NS.boardState) {
    NS.computedValues = {};
    return;
  }
  NS.statusSummary = summarizeBoardState(NS.boardState);
  NS.computedValues = Object.fromEntries(
    (NS.boardState.cardIds ?? []).map((cardId) => [cardId, NS.boardState.modelsById?.[cardId]?.computed_values ?? {}]),
  );
}

function selectLiveCardModelFromPayload(payload, cardId) {
  const cardDefinitions = Array.isArray(payload?.cardDefinitions) ? payload.cardDefinitions : [];
  const card = cardDefinitions.find((entry) => entry?.id === cardId) ?? { id: cardId, card_data: {} };
  const statusEntry = buildStatusCardIndex(payload?.statusSnapshot).get(cardId) ?? null;
  const runtimeEntry = payload?.cardRuntimeById?.[cardId] ?? null;
  const requires = {};
  for (const token of normalizeRequiredTokens(card?.requires)) {
    requires[token] = Object.prototype.hasOwnProperty.call(payload?.dataObjectsByToken ?? {}, token)
      ? payload.dataObjectsByToken[token]
      : null;
  }
  return {
    id: cardId,
    card,
    card_data: card?.card_data ?? {},
    requires,
    computed_values: runtimeEntry?.computed_values ?? {},
    runtime_state: {
      task_status: statusEntry?.status ?? null,
      card_status: statusEntry?.status ?? null,
      runtime: statusEntry?.runtime ?? runtimeEntry?.runtime ?? {},
      error: statusEntry?.error ?? null,
      blocked_by: Array.isArray(statusEntry?.blocked_by) ? statusEntry.blocked_by : [],
      requires_missing: Array.isArray(statusEntry?.requires_missing) ? statusEntry.requires_missing : [],
    },
    card_chats: payload?.cardChatsByCardId?.[cardId] ? normalizeChatState(payload.cardChatsByCardId[cardId]) : null,
  };
}

function reducePayload(payload) {
  if (payload && Array.isArray(payload.cardDefinitions)) {
    NS.latestFullPayload = payload;
    NS.boardState = buildBoardState(payload, NS.boardState, selectLiveCardModelFromPayload);
    const publishedSummary = extractStatusSummaryFromPayload(payload);
    if (publishedSummary) {
      NS.statusSummary = publishedSummary;
    }
    NS.statusGeneration += 1;
    syncProjectedStateFromBoardState();
    if (publishedSummary) {
      NS.statusSummary = publishedSummary;
    }
    return [];
  }

  const notifications = runtimeNotificationsFromPayload(payload);
  if (notifications.length === 0) {
    return notifications;
  }

  if (NS.boardState) {
    NS.boardState = applyNotification(
      NS.boardState,
      notifications,
      selectLiveCardModelFromPayload,
      () => NS.latestFullPayload,
    );
    syncProjectedStateFromBoardState();
  }

  for (const notification of notifications) {
    if (notification?.kind === 'status' && notification.status?.summary) {
      NS.statusSummary = notification.status.summary;
      NS.statusGeneration += 1;
    }
    if (notification && (notification.kind === 'card_removed' || notification.kind === 'card_refreshed') && notification.cardId) {
      NS.boardEvents.push({ kind: notification.kind, cardId: notification.cardId, at: Date.now() });
    }
  }

  return notifications;
}

function applyFrame(payload) {
  reducePayload(payload);
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

function parseRawSseBlocks(buffer) {
  const frames = [];
  let buf = buffer;
  while (true) {
    const idx = buf.indexOf('\n\n');
    if (idx === -1) break;
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    if (!block.trim()) continue;
    const frame = { id: null, event: null, data: '', payload: null, raw: block };
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('id:')) {
        frame.id = line.slice(3).trim();
      } else if (line.startsWith('event:')) {
        frame.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    frame.data = dataLines.join('\n');
    if (!frame.id && !frame.event && !frame.data) continue;
    if (frame.data) {
      try {
        frame.payload = JSON.parse(frame.data);
      } catch { /* ignore malformed */ }
    }
    frames.push(frame);
  }
  return { frames, remainder: buf };
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

function startRawSseClient({ sseUrl, headers = {}, onResponse, onFrame, onClose, onError }) {
  let closed = false;
  const req = http.request(sseUrl, { headers }, (res) => {
    let buf = '';
    res.setEncoding('utf-8');
    try { onResponse?.(res); } catch { /* ignore */ }
    res.on('data', (chunk) => {
      buf = normalizeSseChunkBuffer(buf, chunk);
      const parsed = parseRawSseBlocks(buf);
      buf = parsed.remainder;
      for (const frame of parsed.frames) {
        try { onFrame?.(frame, res); } catch { /* ignore */ }
      }
    });
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      try { onClose?.(res); } catch { /* ignore */ }
    };
    res.on('end', closeOnce);
    res.on('close', closeOnce);
    res.on('error', (err) => {
      try { onError?.(err); } catch { /* ignore */ }
    });
  });
  req.on('error', (err) => {
    try { onError?.(err); } catch { /* ignore */ }
  });
  req.end();
  return {
    close() {
      try { req.destroy(); } catch { /* ignore */ }
    },
  };
}

function waitForRawSseFrames({ sseUrl, headers = {}, until, timeoutMs = 15_000, waitForClose = false }) {
  return new Promise((resolve, reject) => {
    const state = { statusCode: null, headers: {}, frames: [], closed: false };
    let settled = false;
    let client = null;
    const predicate = typeof until === 'function' ? until : ((current) => current.frames.length > 0);

    function maybeResolve() {
      if (settled) return;
      if (!predicate(state)) return;
      if (waitForClose && !state.closed) return;
      settled = true;
      clearTimeout(timeout);
      if (!waitForClose && client) client.close();
      resolve(state);
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (client) client.close();
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for raw SSE frames`));
    }, timeoutMs);

    client = startRawSseClient({
      sseUrl,
      headers,
      onResponse(res) {
        state.statusCode = res.statusCode ?? null;
        state.headers = res.headers || {};
        maybeResolve();
      },
      onFrame(frame) {
        state.frames.push(frame);
        maybeResolve();
      },
      onClose() {
        state.closed = true;
        maybeResolve();
      },
      onError(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      },
    });
  });
}

function waitForFirstSsePayload(sseUrl, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (client) client.close();
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for: first SSE payload`));
    }, timeoutMs);

    client = startSseClient(sseUrl, (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.close();
      resolve(payload);
    });
  });
}

function captureChatEvents(payload, cardId) {
  const notifications = reducePayload(payload);
  for (const notification of notifications) {
    if (!notification?.cardId) continue;
    if (notification.kind !== 'card_chats' && notification.kind !== 'chat_messages' && notification.kind !== 'chat_processing') continue;
    const chatState = normalizeChatState(NS.boardState?.modelsById?.[notification.cardId]?.card_chats ?? null);
    const next = {
      at: Date.now(),
      cardId: notification.cardId,
      processing: chatState.processing,
      receiving: chatState.receiving,
      messageCount: chatState.messages.length,
      messages: chatState.messages,
    };
    NS.allChatNotifications.push(next);
    if (notification.cardId === cardId) {
      NS.chatEvents.push(next);
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

function waitUntilAsync(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(async () => {
      let result;
      try { result = await predicate(); } catch { /* retry */ }
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

function extractStatusSummaryFromPayload(payload) {
  if (payload?.statusSnapshot?.summary && typeof payload.statusSnapshot.summary === 'object') {
    return payload.statusSnapshot.summary;
  }
  if (payload?.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
    for (const notification of payload.notifications) {
      if (notification?.kind === 'status' && notification.status?.summary && typeof notification.status.summary === 'object') {
        return notification.status.summary;
      }
    }
  }
  return null;
}

function normalizeHydratedChatMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: String(message?.role || ''),
    text: String(message?.text || ''),
    files: Array.isArray(message?.files) ? message.files : [],
  }));
}

function readHeaderValue(headers, name) {
  const raw = headers?.[name.toLowerCase()];
  return Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
}

function buildTsStaticCard(cardId, label) {
  return {
    id: cardId,
    meta: {
      title: label,
      tags: ['ts', 'sse'],
      desc: `${label} disposable SSE delta card`,
    },
    compute: [],
    view: {
      elements: [
        {
          kind: 'markdown',
          data: {
            bind: 'card_data.text',
          },
        },
      ],
      layout: {
        board: {
          col: 2,
          order: 99,
        },
        canvas: {
          x: 1600,
          y: 600,
          w: 260,
          h: 120,
        },
      },
      features: {},
    },
    card_data: {
      text: label,
    },
  };
}

function buildChatProbeCard(cardId, label) {
  return {
    id: cardId,
    meta: {
      title: label,
      tags: ['chat', 'probe'],
      desc: `${label} disposable chat probe card`,
    },
    provides: [
      {
        bindTo: 'holdings',
        ref: 'card_data.holdings',
      },
    ],
    compute: [],
    view: {
      elements: [
        {
          kind: 'editable-table',
          label: 'Holdings',
          data: {
            bind: 'card_data.holdings',
            writeTo: 'card_data.holdings',
            columns: ['ticker', 'quantity', 'cost_basis'],
            schema: {
              properties: {
                quantity: { type: 'number' },
                cost_basis: { type: 'number' },
              },
            },
          },
        },
      ],
      layout: {
        board: {
          col: 3,
          order: 98,
        },
        canvas: {
          x: 1400,
          y: 420,
          w: 320,
          h: 260,
        },
      },
      features: {
        chat: true,
      },
    },
    card_data: {
      holdings: [
        { ticker: 'AAPL', quantity: 1, cost_basis: 150 },
      ],
    },
  };
}

function assertObjectContains(actual, expected, label) {
  assert(actual && typeof actual === 'object', `${label} actual value is not an object`);
  assert(expected && typeof expected === 'object', `${label} expected value is not an object`);
  for (const [key, value] of Object.entries(expected)) {
    assert(Object.is(actual[key], value), `${label}.${key} mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
  }
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
  let prevProcessing = Boolean(opts.beforeProcessing);
  const prompt = String(opts.prompt || '');
  const assistantText = opts.assistantText == null ? `Echo: ${prompt}` : String(opts.assistantText);
  const inProgressText = String(opts.inProgressText || PROBE_IN_PROGRESS_TEXT);
  const seenRelevantMessages = new Set();

  for (const event of events) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    for (const message of messages) {
      const role = String(message?.role || '');
      const text = String(message?.text || '');
      const turn = typeof message?.turn === 'string' ? message.turn : '';
      const signature = `${turn}|${role}|${text}`;
      if (seenRelevantMessages.has(signature)) continue;

      if (role === 'user' && text.includes(prompt)) {
        milestones.push('user');
        seenRelevantMessages.add(signature);
      } else if (role === 'system' && text.trim().toLowerCase() === inProgressText) {
        milestones.push('in-progress');
        seenRelevantMessages.add(signature);
      } else if (role === 'assistant' && text.includes(assistantText)) {
        milestones.push('assistant');
        seenRelevantMessages.add(signature);
      }
    }

    const processing = Boolean(event?.processing);
    if (processing !== prevProcessing) milestones.push(processing ? 'processing-true' : 'processing-false');

    prevProcessing = processing;
  }

  return milestones;
}

function matchOrderedProbeLifecycle(events, opts) {
  const milestones = deriveProbeLifecycleMilestones(events, opts);
  const userIdx = milestones.indexOf('user');
  const processingTrueIdx = milestones.indexOf('processing-true');
  const assistantIdx = milestones.indexOf('assistant');
  const processingFalseIdx = milestones.lastIndexOf('processing-false');
  const inProgressIdx = milestones.indexOf('in-progress');

  if (userIdx === -1 || processingTrueIdx === -1 || assistantIdx === -1 || processingFalseIdx === -1) {
    return false;
  }

  if (Math.max(userIdx, processingTrueIdx) >= assistantIdx) return false;
  if (assistantIdx >= processingFalseIdx) return false;
  if (inProgressIdx !== -1 && (inProgressIdx <= processingTrueIdx || inProgressIdx >= assistantIdx)) return false;

  return { milestones };
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
let boardSseClient = null;
let chatSseClient = null;
let chatSseClientId = '';

try {
  // ── T0: streaming SSE connect, upsert fixtures, wait for initial completion ──

  // Register the 'live' board via POST (v8 runtime requires explicit registration)
  const regRes = await httpJson('POST', `http://127.0.0.1:${PORT}/api/boards`, { id: BOARD_ID, label: 'Live' });
  assert(regRes.status === 200 || regRes.status === 201 || regRes.status === 409,
    `POST /api/boards returned ${regRes.status}: ${JSON.stringify(regRes.data)}`);
  console.log(`[setup] board '${BOARD_ID}' registered (${regRes.status})`);

  console.log('\n=== T0 Step 1: start SSE client (board expected empty) ===');
  const sseClientId = `server-http-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sseUrl = `${BASE}/sse?clientId=${encodeURIComponent(sseClientId)}`;
  boardSseClient = startSseClient(sseUrl, applyFrame);
  // Give the streaming endpoint a moment to deliver the initial (empty) snapshot.
  await wait(500);
  console.log('[T0.1] SSE client connected');

  console.log('\n=== T0 Step 2: upsert 3 cardT-* fixtures ===');
  for (const fileName of T0_CARD_FILES) {
    const cardJson = JSON.parse(fs.readFileSync(path.join(CARDS_DIR, fileName), 'utf-8'));
    const cardId = cardJson?.id;
    assert(typeof cardId === 'string' && cardId.length > 0, `fixture ${fileName} missing id`);
    const upsertRes = await httpMcp('manage.upsert-card', {
      card_id: cardId,
      candidate_card_content: cardJson,
    });
    assert(upsertRes.status === 200, `manage.upsert-card(${cardId}) returned ${upsertRes.status}: ${JSON.stringify(upsertRes.data)}`);
    assert(upsertRes.data?.status === 'success', `manage.upsert-card(${cardId}) failed: ${JSON.stringify(upsertRes.data)}`);
    console.log(`[T0.2] upserted ${cardId}`);
  }

  console.log('\n=== T0 Step 3: wait for all 3 cards to complete via SSE ===');
  const t0Summary = await waitUntil(() => {
    const s = NS.statusSummary;
    if (s && s.card_count === 3 && s.completed === 3) return s;
    return false;
  }, 60_000, 'T0 initial completion (3 cards)');
  assert(t0Summary.failed === 0, `T0 expected failed=0, got ${t0Summary.failed}`);
  console.log(`[T0.3] completed: ${JSON.stringify(t0Summary)}`);

  console.log('\n=== T0 Step 4: board-status cross-check ===');
  const statusMcpRes = await httpMcp('inspect.board-runtime-status', {});
  assert(statusMcpRes.status === 200, `inspect.board-runtime-status returned ${statusMcpRes.status}`);
  assert(statusMcpRes.data?.status === 'success', `inspect.board-runtime-status failed: ${JSON.stringify(statusMcpRes.data)}`);
  const mcpSummary = statusMcpRes.data?.data?.summary;
  assert(mcpSummary, 'summary missing from inspect.board-runtime-status');
  assert(mcpSummary.card_count === T0_EXPECTED_CARD_IDS.length,
    `expected card_count=${T0_EXPECTED_CARD_IDS.length}, got ${mcpSummary.card_count}`);
  assert(mcpSummary.completed === mcpSummary.card_count, `not all complete: ${JSON.stringify(mcpSummary)}`);
  console.log(`[T0.4] board-status: ${JSON.stringify(mcpSummary)}`);

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
    console.log('\n=== T2: MCP file upload -> card_data.files -> download ===');
    const t2CardBefore = await httpMcp('manage.read-card', { card_id: T2_FILE_CARD_ID });
    assert(t2CardBefore.status === 200, `T2 pre card read returned ${t2CardBefore.status}`);
    const t2FilesBefore = Array.isArray(t2CardBefore.data?.data?.[0]?.card_data?.files)
      ? t2CardBefore.data.data[0].card_data.files
      : [];
    const t2BeforeCount = t2FilesBefore.length;

    const t2UploadText = `plain-file-upload-${Date.now()}`;
    const t2UploadName = 't2-upload.txt';
    const t2UploadRes = await httpMcpControlplane('manage.upload-card-file', {
      board_id: BOARD_ID,
      card_id: T2_FILE_CARD_ID,
      file_name: t2UploadName,
      content_type: 'text/plain; charset=utf-8',
      base64: Buffer.from(t2UploadText, 'utf-8').toString('base64'),
    });
    assert(t2UploadRes.status === 200, `T2 file upload returned ${t2UploadRes.status}`);
    const t2UploadedFile = t2UploadRes.data?.data?.file;
    assert(t2UploadedFile && typeof t2UploadedFile === 'object', 'T2 upload response missing file metadata');
    assert(String(t2UploadedFile?.name || '') === t2UploadName, 'T2 uploaded file name mismatch');

    const t2CardAfter = await httpMcp('manage.read-card', { card_id: T2_FILE_CARD_ID });
    assert(t2CardAfter.status === 200, `T2 post card read returned ${t2CardAfter.status}`);
    const t2FilesAfter = Array.isArray(t2CardAfter.data?.data?.[0]?.card_data?.files)
      ? t2CardAfter.data.data[0].card_data.files
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
      const t2Before = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
      t3Dbg(`step 3: pre-chat fetch returned status=${t2Before.status}`);
      assert(t2Before.status === 200, `T3 pre chats returned ${t2Before.status}`);
      const t2BeforeMessages = Array.isArray(t2Before.data?.data?.messages) ? t2Before.data.data.messages : [];
      const t2BeforeCount = t2BeforeMessages.length;
      const t2EventStart = NS.chatEvents.length;
      const t2ProbePrompt = `Probe protocol validation ${Date.now()}`;
      t3Dbg(`step 3: beforeCount=${t2BeforeCount}, eventStart=${t2EventStart}`);

      const t3TurnId = randomTurnId();
      t3Dbg(`step 4: posting probe chat-send (turn-id=${t3TurnId})`);
      const t2SendRes = await httpJson('POST', `${BASE}/mcp-actions`, {
        tool: 'chat-send',
        args: {
          card_id: CHAT_CARD_ID,
          payload: {
            text: `${ECHO_PROBE_MARKER}${t2ProbePrompt}${ECHO_PROBE_MARKER}`,
            'turn-id': t3TurnId,
          },
        },
      });
      t3Dbg(`step 4: chat-send returned status=${t2SendRes.status}`);
      assert(t2SendRes.status === 200, `T3 chat-send returned ${t2SendRes.status}`);

      t3Dbg('step 5: waiting for ordered probe lifecycle on chat SSE');
      let t2Lifecycle;
      try {
        t2Lifecycle = await waitForChatPredicate((events) => {
          return matchOrderedProbeLifecycle(events.slice(t2EventStart), {
            beforeCount: t2BeforeCount,
            beforeProcessing: false,
            prompt: t2ProbePrompt,
            inProgressText: PROBE_IN_PROGRESS_TEXT,
          });
        }, 45_000, 'T3 ordered lifecycle');
      } catch (error) {
        t3Dbg(`step 5: lifecycle timeout; events=${JSON.stringify(NS.chatEvents.slice(t2EventStart), null, 2)}`);
        throw error;
      }
      t3Dbg('step 5: ordered lifecycle observed');
      assert(!!t2Lifecycle, 'T3 ordered lifecycle not observed');

      t3Dbg('step 6: fetching post-chat transcript');
      const t2After = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
      t3Dbg(`step 6: post-chat fetch returned status=${t2After.status}`);
      assert(t2After.status === 200, `T3 post chats returned ${t2After.status}`);
      const t2AfterMessages = Array.isArray(t2After.data?.data?.messages) ? t2After.data.data.messages : [];
      const t2NewMessages = t2AfterMessages.slice(t2BeforeCount);
      t3Dbg(`step 6: validating ${t2NewMessages.length} new messages`);
      assert(t2NewMessages.length >= 2, `T3 expected at least 2 new chat messages, got ${t2NewMessages.length}`);
      const t3McpAfter = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, turn_id: t3TurnId });
      const t3McpAfterData = expectMcpSuccess(t3McpAfter, 'T3 MCP post chats');
      const t3TurnMessages = Array.isArray(t3McpAfterData?.messages) ? t3McpAfterData.messages : [];
      t3Dbg(`step 6: MCP turn messages count=${t3TurnMessages.length}`);
      assert(t3TurnMessages.length >= 2, `T3 expected at least 2 MCP messages for turn ${t3TurnId}, got ${t3TurnMessages.length}`);
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
      assert(String(t2User?.text || '') === t2ProbePrompt, `T3 expected stored user text to equal prompt without probe envelope, got ${JSON.stringify(String(t2User?.text || ''))}`);
      assert(!String(t2User?.text || '').includes(ECHO_PROBE_MARKER), 'T3 stored user text should not include probe envelope markers');
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
    const t2aBefore = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
    t3aDbg(`step 1: pre-chat fetch returned status=${t2aBefore.status}`);
    assert(t2aBefore.status === 200, `T3a pre chats returned ${t2aBefore.status}`);
    const t2aBeforeMessages = Array.isArray(t2aBefore.data?.data?.messages) ? t2aBefore.data.data.messages : [];
    const t2aBeforeCount = t2aBeforeMessages.length;
    const t2aPrompt = 'Just answer what is the capital of France. No Fluff. No COmmentary.  No Markup Respond in lower case in one word.';
    t3aDbg(`step 1: beforeCount=${t2aBeforeCount}`);

    const t3aTurnId = randomTurnId();
    t3aDbg(`step 2: posting non-probe chat-send (turn-id=${t3aTurnId})`);
    const t2aSendRes = await httpJson('POST', `${BASE}/mcp-actions`, {
      tool: 'chat-send',
      args: {
        card_id: CHAT_CARD_ID,
        payload: {
          text: JSON.stringify({
            prompt: t2aPrompt,
            chatTimeoutMs: 180000,
          }),
          'turn-id': t3aTurnId,
        },
      },
    });
    t3aDbg(`step 2: chat-send returned status=${t2aSendRes.status}`);
    assert(t2aSendRes.status === 200, `T3a chat-send returned ${t2aSendRes.status}`);

    t3aDbg('step 3: waiting for assistant message containing paris on chat SSE');
    const t2aAssistant = await waitForChatPredicate((events) => {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        const messages = Array.isArray(e?.messages) ? e.messages : [];
        const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
        if (assistant?.role === 'assistant' && /paris/i.test(String(assistant.text || ''))) return e;
      }
      return false;
    }, 240_000, 'T3a assistant response with paris');
    t3aDbg('step 3: assistant SSE event observed');
    assert(!!t2aAssistant, 'T3a assistant response with paris not observed on SSE');
    const t2aSseLast = t2aAssistant.messages[t2aAssistant.messages.length - 1];
    t3aDbg(`step 3: assistant SSE text=${JSON.stringify(String(t2aSseLast?.text || '').slice(0, 400))}`);

    t3aDbg('step 4: fetching post-chat transcript');
    const t2aAfter = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
    t3aDbg(`step 4: post-chat fetch returned status=${t2aAfter.status}`);
    assert(t2aAfter.status === 200, `T3a post chats returned ${t2aAfter.status}`);
    const t2aAfterMessages = Array.isArray(t2aAfter.data?.data?.messages) ? t2aAfter.data.data.messages : [];
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
    const t2bBefore = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
    assert(t2bBefore.status === 200, `T3b pre chats returned ${t2bBefore.status}`);
    const t2bBeforeMessages = Array.isArray(t2bBefore.data?.data?.messages) ? t2bBefore.data.data.messages : [];
    const t2bBeforeCount = t2bBeforeMessages.length;

    const t3bTurnId = randomTurnId();
    const t2bUploadRes = await httpMcpControlplane('manage.add-chat-attachment', {
      board_id: BOARD_ID,
      card_id: CHAT_CARD_ID,
      turn_id: t3bTurnId,
      file_name: 'q1.txt',
      content_type: 'text/plain; charset=utf-8',
      base64: Buffer.from('tokyo', 'utf-8').toString('base64'),
    });
    assert(t2bUploadRes.status === 200, `T3b file upload returned ${t2bUploadRes.status}`);
    const uploadedFile = t2bUploadRes.data?.data?.files?.[0];
    assert(uploadedFile && typeof uploadedFile === 'object', 'T3b upload response missing file metadata');

    const t2bAfterUpload = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
    assert(t2bAfterUpload.status === 200, `T3b chats after upload returned ${t2bAfterUpload.status}`);
    const t2bUploadMessages = Array.isArray(t2bAfterUpload.data?.data?.messages) ? t2bAfterUpload.data.data.messages : [];
    const t2bUploadNewMessages = t2bUploadMessages.slice(t2bBeforeCount);
    const t2bUploadSystem = t2bUploadNewMessages.find((m) => m?.role === 'system');
    assert(!!t2bUploadSystem, 'T3b upload protocol missing system chat file');
    assert(String(t2bUploadSystem?.text || '').toLowerCase().includes('file uploaded:'), 'T3b upload system message does not describe uploaded file');

    const t2bCardAfterUpload = await httpMcp('manage.read-card', { card_id: CHAT_CARD_ID });
    assert(t2bCardAfterUpload.status === 200, `T3b card read after upload returned ${t2bCardAfterUpload.status}`);
    const t2bFilesAfterUpload = Array.isArray(t2bCardAfterUpload.data?.data?.[0]?.card_data?.files)
      ? t2bCardAfterUpload.data.data[0].card_data.files
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
    const t2bSendRes = await httpJson('POST', `${BASE}/mcp-actions`, {
      tool: 'chat-send',
      args: {
        card_id: CHAT_CARD_ID,
        payload: {
          text: `${ECHO_PROBE_MARKER}${t2bPrompt}${ECHO_PROBE_MARKER}`,
          'turn-id': t3bTurnId,
        },
      },
    });
    assert(t2bSendRes.status === 200, `T3b chat-send returned ${t2bSendRes.status}`);

    const t2bLifecycle = await waitForChatPredicate((events) => {
      return matchOrderedProbeLifecycle(events.slice(t2bEventStart), {
        beforeCount: t2bSendBaseline,
        beforeProcessing: false,
        prompt: t2bPrompt,
        inProgressText: PROBE_IN_PROGRESS_TEXT,
      });
    }, 60_000, 'T3b ordered lifecycle').catch(async (err) => {
      const t2bEvents = NS.chatEvents.slice(t2bEventStart);
      const t2bMilestones = deriveProbeLifecycleMilestones(t2bEvents, {
        beforeCount: t2bSendBaseline,
        beforeProcessing: false,
        prompt: t2bPrompt,
        inProgressText: PROBE_IN_PROGRESS_TEXT,
      });
      const t2bCurrent = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
      console.error('[T3b.DBG timeout] milestones=', JSON.stringify(t2bMilestones));
      console.error('[T3b.DBG timeout] events=', JSON.stringify(t2bEvents));
      console.error('[T3b.DBG timeout] inspect=', JSON.stringify(t2bCurrent?.data ?? null));
      throw err;
    });
    assert(!!t2bLifecycle, 'T3b ordered lifecycle not observed');

    const t2bAfter = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
    assert(t2bAfter.status === 200, `T3b post chats returned ${t2bAfter.status}`);
    const t2bAfterMessages = Array.isArray(t2bAfter.data?.data?.messages) ? t2bAfter.data.data.messages : [];
    const t2bNewMessages = t2bAfterMessages.slice(t2bSendBaseline);
    assert(t2bNewMessages.length >= 2, `T3b expected at least 2 chat messages after send, got ${t2bNewMessages.length}`);

    const t2bUser = t2bNewMessages.find((m) => m?.role === 'user');
    const t2bInProgress = t2bNewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
    const t2bAssistantMsg = t2bNewMessages.find((m) => m?.role === 'assistant');

    assert(!!t2bUser && typeof t2bUser.id === 'string', 'T3b missing user chat message notification');
    assert(!!t2bAssistantMsg && typeof t2bAssistantMsg.id === 'string', 'T3b missing assistant chat message notification');
    assert(!Array.isArray(t2bUser?.files) || t2bUser.files.length === 0, 'T3b user chat message should remain text-only after add-chat-attachment upload');
    assert(String(t2bAssistantMsg?.text || '').includes(`Echo: ${t2bPrompt}`), 'T3b assistant probe echo mismatch');
    console.log('[T3b] ok: add-chat-attachment upload plus text-only chat-send preserved the normal probe lifecycle');

    if (skipT3e) {
      console.log('\n=== T3e: skipped (--skip-t3e) ===');
    } else {
      console.log('\n=== T3e: subscribed chat turn with attachment plus unsubscribed negative case ===');
      const t3eOtherCardId = `card-t3e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const t3eOtherCard = buildChatProbeCard(t3eOtherCardId, 'T3e Chat Probe');

      const t3eUpsertOtherRes = await httpMcp('manage.upsert-card', {
        card_id: t3eOtherCardId,
        candidate_card_content: t3eOtherCard,
      });
      assert(t3eUpsertOtherRes.status === 200, `T3e manage.upsert-card(${t3eOtherCardId}) returned ${t3eUpsertOtherRes.status}`);
      assert(t3eUpsertOtherRes.data?.status === 'success', `T3e manage.upsert-card(${t3eOtherCardId}) failed: ${JSON.stringify(t3eUpsertOtherRes.data)}`);
      await waitUntil(() => {
        const s = NS.statusSummary;
        if (s && s.card_count === T0_EXPECTED_CARD_IDS.length + 1) return s;
        return false;
      }, 30_000, 'T3e extra chat card visible in board summary');

      try {
        const t3eBefore = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
        assert(t3eBefore.status === 200, `T3e pre chats returned ${t3eBefore.status}`);
        const t3eBeforeMessages = Array.isArray(t3eBefore.data?.data?.messages) ? t3eBefore.data.data.messages : [];
        const t3eBeforeCount = t3eBeforeMessages.length;

        const t3eTurnId = randomTurnId();
        const t3eUploadRes = await httpMcpControlplane('manage.add-chat-attachment', {
          board_id: BOARD_ID,
          card_id: CHAT_CARD_ID,
          turn_id: t3eTurnId,
          file_name: 't3e-probe.txt',
          content_type: 'text/plain; charset=utf-8',
          text: 'what is the capital of japan',
        });
        assert(t3eUploadRes.status === 200, `T3e file upload returned ${t3eUploadRes.status}`);
        assert(t3eUploadRes.data?.status === 'success', `T3e file upload failed: ${JSON.stringify(t3eUploadRes.data)}`);
        const t3eUploadedFile = t3eUploadRes.data?.data?.files?.[0];
        assert(t3eUploadedFile && typeof t3eUploadedFile === 'object', 'T3e upload response missing file metadata');
        assert(!Object.prototype.hasOwnProperty.call(t3eUploadedFile, 'path'), 'T3e uploaded file metadata should not expose path');

        const t3eCardAfterUpload = await httpMcp('manage.read-card', { card_id: CHAT_CARD_ID });
        assert(t3eCardAfterUpload.status === 200, `T3e card read after upload returned ${t3eCardAfterUpload.status}`);
        const t3eStoredFiles = Array.isArray(t3eCardAfterUpload.data?.data?.[0]?.card_data?.files)
          ? t3eCardAfterUpload.data.data[0].card_data.files
          : [];
        const t3eStoredFile = t3eStoredFiles.find((file) => String(file?.stored_name || '') === String(t3eUploadedFile?.stored_name || ''));
        assert(!!t3eStoredFile, 'T3e stored file metadata missing after upload');
        assert(t3eStoredFile?.chat === true, 'T3e stored file should be marked as chat-origin');
        assert(!Object.prototype.hasOwnProperty.call(t3eStoredFile || {}, 'path'), 'T3e stored file metadata should not expose path');

        const t3eUploadMessages = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, turn_id: t3eTurnId });
        assert(t3eUploadMessages.status === 200, `T3e chats after upload returned ${t3eUploadMessages.status}`);
        const t3eUploadTurnMessages = Array.isArray(t3eUploadMessages.data?.data?.messages) ? t3eUploadMessages.data.data.messages : [];
        const t3eUploadSystem = t3eUploadTurnMessages.find((message) => message?.role === 'system');
        assert(!!t3eUploadSystem, 'T3e upload protocol missing system chat message');
        assert(String(t3eUploadSystem?.text || '').toLowerCase().includes('file uploaded:'), 'T3e upload system message does not describe uploaded file');

        const t3eEventStart = NS.chatEvents.length;
        const t3eAllNotificationsStart = NS.allChatNotifications.length;
        const t3ePrompt = `attachment probe ${Date.now()}`;
        const t3eProbeText = `${ECHO_PROBE_MARKER}${t3ePrompt}${ECHO_PROBE_MARKER}`;
        const t3eSendRes = await httpJson('POST', `${BASE}/mcp-actions`, {
          tool: 'chat-send',
          args: {
            card_id: CHAT_CARD_ID,
            payload: {
              text: t3eProbeText,
              'turn-id': t3eTurnId,
            },
          },
        });
        assert(t3eSendRes.status === 200, `T3e chat-send returned ${t3eSendRes.status}`);

        const t3eLifecycle = await waitForChatPredicate((events) => {
          return matchOrderedProbeLifecycle(events.slice(t3eEventStart), {
            beforeCount: t3eBeforeCount + t3eUploadTurnMessages.length,
            beforeProcessing: false,
            prompt: t3ePrompt,
            inProgressText: PROBE_IN_PROGRESS_TEXT,
          });
        }, 60_000, 'T3e ordered lifecycle');
        assert(!!t3eLifecycle, 'T3e ordered lifecycle not observed');

        const t3eAfter = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, turn_id: t3eTurnId });
        assert(t3eAfter.status === 200, `T3e post chats returned ${t3eAfter.status}`);
        const t3eFinalMessages = Array.isArray(t3eAfter.data?.data?.messages) ? t3eAfter.data.data.messages : [];
        const t3eFinalUser = t3eFinalMessages.find((message) => message?.role === 'user');
        const t3eFinalAssistant = t3eFinalMessages.find((message) => message?.role === 'assistant');
        assert(!!t3eFinalUser, `T3e final user message missing: ${JSON.stringify(t3eFinalMessages)}`);
        assert(!!t3eFinalAssistant, `T3e final assistant message missing: ${JSON.stringify(t3eFinalMessages)}`);
        assert(String(t3eFinalUser?.text || '') === t3ePrompt, `T3e final user text mismatch: ${JSON.stringify(t3eFinalUser)}`);
        assert(!Array.isArray(t3eFinalUser?.files) || t3eFinalUser.files.length === 0,
          `T3e final user message should remain text-only after controlplane attachment upload: ${JSON.stringify(t3eFinalUser)}`);
        assert(String(t3eFinalAssistant?.text || '').includes(`Echo: ${t3ePrompt}`), `T3e final probe reply mismatch: ${JSON.stringify(t3eFinalAssistant)}`);

        const t3eNegativeTurnId = randomTurnId();
        const t3eNegativeSendRes = await httpJson('POST', `${BASE}/mcp-actions`, {
          tool: 'chat-send',
          args: {
            card_id: t3eOtherCardId,
            payload: {
              text: `${ECHO_PROBE_MARKER}negative unsubscribed ${Date.now()}${ECHO_PROBE_MARKER}`,
              'turn-id': t3eNegativeTurnId,
            },
          },
        });
        assert(t3eNegativeSendRes.status === 200, `T3e negative chat-send returned ${t3eNegativeSendRes.status}`);

        const t3eNegativePersisted = await waitUntilAsync(async () => {
          const result = await httpMcp('inspect.chat-messages-on-cards', { card_id: t3eOtherCardId, turn_id: t3eNegativeTurnId });
          if (result.status !== 200) return false;
          const messages = Array.isArray(result.data?.data?.messages) ? result.data.data.messages : [];
          return messages.find((message) => message?.role === 'assistant') ? messages : false;
        }, 60_000, 'T3e negative turn persisted on unsubscribed card');
        assert(Array.isArray(t3eNegativePersisted), 'T3e negative turn did not persist as expected');

        await wait(1_500);
        const t3eUnexpectedNotification = NS.allChatNotifications.slice(t3eAllNotificationsStart)
          .find((event) => event?.cardId === t3eOtherCardId);
        assert(!t3eUnexpectedNotification,
          `T3e unsubscribed client unexpectedly received chat notification for ${t3eOtherCardId}: ${JSON.stringify(t3eUnexpectedNotification)}`);

        console.log('[T3e] ok: subscribed client received attachment-bearing turn and unsubscribed card produced no chat SSE notification');
      } finally {
        const t3eRemoveOtherRes = await httpMcp('manage.remove-card', { card_id: t3eOtherCardId });
        assert(t3eRemoveOtherRes.status === 200, `T3e manage.remove-card(${t3eOtherCardId}) returned ${t3eRemoveOtherRes.status}`);
        assert(t3eRemoveOtherRes.data?.status === 'success', `T3e manage.remove-card(${t3eOtherCardId}) failed: ${JSON.stringify(t3eRemoveOtherRes.data)}`);
        await waitUntil(() => {
          const s = NS.statusSummary;
          if (s && s.card_count === T0_EXPECTED_CARD_IDS.length) return s;
          return false;
        }, 30_000, 'T3e cleanup card_count back to 3');
      }
    }

    console.log('\n=== T3c: fresh /sse connect hydrates current board state ===');
    const t3cInspectStatusRes = await httpMcp('inspect.board-runtime-status', {});
    assert(t3cInspectStatusRes.status === 200, `T3c inspect.board-runtime-status returned ${t3cInspectStatusRes.status}`);
    assert(t3cInspectStatusRes.data?.status === 'success', `T3c inspect.board-runtime-status failed: ${JSON.stringify(t3cInspectStatusRes.data)}`);
    const t3cExpectedSummary = t3cInspectStatusRes.data?.data?.summary;
    assert(t3cExpectedSummary, 'T3c summary missing from inspect.board-runtime-status');

    const t3cExpectedCards = {};
    for (const cardId of T0_EXPECTED_CARD_IDS) {
      const t3cInspectCardRes = await httpMcp('inspect.card-definition-and-runtime', { card_id: cardId });
      assert(t3cInspectCardRes.status === 200, `T3c inspect.card-definition-and-runtime(${cardId}) returned ${t3cInspectCardRes.status}`);
      assert(t3cInspectCardRes.data?.status === 'success', `T3c inspect.card-definition-and-runtime(${cardId}) failed: ${JSON.stringify(t3cInspectCardRes.data)}`);
      const t3cInspectCardData = t3cInspectCardRes.data?.data;
      assert(t3cInspectCardData && typeof t3cInspectCardData === 'object', `T3c inspect.card-definition-and-runtime(${cardId}) missing data`);
      t3cExpectedCards[cardId] = t3cInspectCardData;
    }

    const t3cRefreshClientId = `server-http-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const t3cRefreshPayload = await waitForFirstSsePayload(`${BASE}/sse?clientId=${encodeURIComponent(t3cRefreshClientId)}`);
    assert(t3cRefreshPayload && typeof t3cRefreshPayload === 'object', 'T3c missing refresh SSE payload');

    const t3cCardDefinitions = Array.isArray(t3cRefreshPayload.cardDefinitions) ? t3cRefreshPayload.cardDefinitions : [];
    const t3cCardIds = t3cCardDefinitions.map((card) => card?.id).filter((id) => typeof id === 'string').sort();
    assert(JSON.stringify(t3cCardIds) === JSON.stringify(T0_EXPECTED_CARD_IDS),
      `T3c refreshed SSE cardDefinitions mismatch: ${JSON.stringify(t3cCardIds)}`);

    const t3cStatusSummary = t3cRefreshPayload.statusSnapshot?.summary;
    assert(t3cStatusSummary, 'T3c refresh SSE payload missing statusSnapshot.summary');
    assertObjectContains(t3cStatusSummary, t3cExpectedSummary, 'T3c refresh SSE summary');

    const t3cCardRuntimeById = t3cRefreshPayload.cardRuntimeById && typeof t3cRefreshPayload.cardRuntimeById === 'object'
      ? t3cRefreshPayload.cardRuntimeById
      : {};
    for (const card of t3cCardDefinitions) {
      const cardId = card?.id;
      if (typeof cardId !== 'string' || !t3cExpectedCards[cardId]) continue;
      const t3cExpectedCard = t3cExpectedCards[cardId];
      assert(JSON.stringify(card) === JSON.stringify(t3cExpectedCard.card_definition_and_static_data),
        `T3c refresh SSE cardDefinitions[${cardId}] mismatch`);

      const t3cHydratedCardRuntime = t3cCardRuntimeById[cardId];
      assert(t3cHydratedCardRuntime && typeof t3cHydratedCardRuntime === 'object', `T3c refresh SSE payload missing cardRuntimeById.${cardId}`);
      assert(JSON.stringify(t3cHydratedCardRuntime.card_data || {}) === JSON.stringify(t3cExpectedCard.card_definition_and_static_data?.card_data || {}),
        `T3c refresh SSE cardRuntimeById.${cardId}.card_data mismatch`);
      assert(JSON.stringify(t3cHydratedCardRuntime.computed_values || {}) === JSON.stringify(t3cExpectedCard.runtime_data?.computed_values || {}),
        `T3c refresh SSE cardRuntimeById.${cardId}.computed_values mismatch`);
    }
    console.log('[T3c] ok: fresh /sse first payload hydrated the current board state');

    console.log('\n=== TS: one-shot, raw framing, replay, delta ordering, and chat hydration ===');
    const tsExpectedChatRes = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
    assert(tsExpectedChatRes.status === 200, `TS inspect.chat-messages-on-cards returned ${tsExpectedChatRes.status}`);
    const tsExpectedChatMessages = normalizeHydratedChatMessages(tsExpectedChatRes.data?.data?.messages || []);

    const tsOneShot = await waitForRawSseFrames({
      sseUrl: `${BASE}/sse?one-shot`,
      timeoutMs: 15_000,
      until: (state) => state.frames.length >= 1,
      waitForClose: true,
    });
    assert(tsOneShot.statusCode === 200, `TS one-shot returned ${tsOneShot.statusCode}`);
    assert(/text\/event-stream/i.test(readHeaderValue(tsOneShot.headers, 'content-type')),
      `TS one-shot content-type mismatch: ${readHeaderValue(tsOneShot.headers, 'content-type')}`);
    assert(tsOneShot.closed === true, 'TS one-shot connection should close after first frame');
    assert(tsOneShot.frames.length === 1, `TS one-shot expected exactly 1 frame, got ${tsOneShot.frames.length}`);
    const tsOneShotFrame = tsOneShot.frames[0];
    assert(/^\d+$/.test(String(tsOneShotFrame.id || '')), `TS one-shot frame missing numeric id: ${JSON.stringify(tsOneShotFrame)}`);
    assert(tsOneShotFrame.payload && typeof tsOneShotFrame.payload === 'object', 'TS one-shot frame missing JSON payload');
    const tsOneShotChatState = tsOneShotFrame.payload.cardChatsByCardId?.[CHAT_CARD_ID];
    assert(tsOneShotChatState && typeof tsOneShotChatState === 'object', `TS one-shot payload missing cardChatsByCardId.${CHAT_CARD_ID}`);
    assert(JSON.stringify(normalizeHydratedChatMessages(tsOneShotChatState.messages)) === JSON.stringify(tsExpectedChatMessages),
      'TS one-shot cardChatsByCardId hydration mismatch');

    const tsDeltaClientId = `ts-delta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tsRawFrames = [];
    const tsDeltaClient = startRawSseClient({
      sseUrl: `${BASE}/sse?clientId=${encodeURIComponent(tsDeltaClientId)}`,
      onFrame(frame) {
        tsRawFrames.push(frame);
      },
    });

    try {
      const tsInitialFrame = await waitUntil(() => tsRawFrames[0] || false, 15_000, 'TS initial raw SSE frame');
      assert(/^\d+$/.test(String(tsInitialFrame.id || '')), `TS initial streaming frame missing numeric id: ${JSON.stringify(tsInitialFrame)}`);
      const tsInitialChatState = tsInitialFrame.payload?.cardChatsByCardId?.[CHAT_CARD_ID];
      assert(tsInitialChatState && typeof tsInitialChatState === 'object', `TS initial streaming payload missing cardChatsByCardId.${CHAT_CARD_ID}`);
      assert(JSON.stringify(normalizeHydratedChatMessages(tsInitialChatState.messages)) === JSON.stringify(tsExpectedChatMessages),
        'TS initial streaming cardChatsByCardId hydration mismatch');

      const tsTempCards = [
        buildTsStaticCard(`card-ts-${Date.now()}-a`, 'TS Delta Card A'),
        buildTsStaticCard(`card-ts-${Date.now()}-b`, 'TS Delta Card B'),
      ];
      let tsLastEventId = Number(tsInitialFrame.id);

      for (let idx = 0; idx < tsTempCards.length; idx += 1) {
        const tsCard = tsTempCards[idx];
        const tsExpectedCardCount = T0_EXPECTED_CARD_IDS.length + idx + 1;
        const tsFrameStart = tsRawFrames.length;
        const tsUpsertRes = await httpMcp('manage.upsert-card', {
          card_id: tsCard.id,
          candidate_card_content: tsCard,
        });
        assert(tsUpsertRes.status === 200, `TS manage.upsert-card(${tsCard.id}) returned ${tsUpsertRes.status}`);
        assert(tsUpsertRes.data?.status === 'success', `TS manage.upsert-card(${tsCard.id}) failed: ${JSON.stringify(tsUpsertRes.data)}`);
        const tsDeltaFrame = await waitUntil(() => {
          for (const frame of tsRawFrames.slice(tsFrameStart)) {
            const summary = extractStatusSummaryFromPayload(frame.payload);
            if (summary?.card_count === tsExpectedCardCount) return frame;
          }
          return false;
        }, 30_000, `TS board delta card_count=${tsExpectedCardCount}`);
        assert(Number(tsDeltaFrame.id) > tsLastEventId,
          `TS delta frame id did not increase: prev=${tsLastEventId}, next=${JSON.stringify(tsDeltaFrame.id)}`);
        tsLastEventId = Number(tsDeltaFrame.id);
      }

      tsDeltaClient.close();
      await wait(250);

      const tsReconnect = await waitForRawSseFrames({
        sseUrl: `${BASE}/sse?clientId=${encodeURIComponent(tsDeltaClientId)}`,
        headers: { 'Last-Event-ID': String(tsLastEventId) },
        timeoutMs: 15_000,
        until: (state) => state.frames.length >= 1,
      });
      assert(tsReconnect.statusCode === 200, `TS reconnect returned ${tsReconnect.statusCode}`);
      assert(/text\/event-stream/i.test(readHeaderValue(tsReconnect.headers, 'content-type')),
        `TS reconnect content-type mismatch: ${readHeaderValue(tsReconnect.headers, 'content-type')}`);
      const tsReconnectFrame = tsReconnect.frames[0];
      assert(Number(tsReconnectFrame.id) > tsLastEventId,
        `TS reconnect frame id did not advance beyond Last-Event-ID: prev=${tsLastEventId}, next=${JSON.stringify(tsReconnectFrame.id)}`);
      const tsReconnectPayload = tsReconnectFrame.payload;
      assert(tsReconnectPayload && typeof tsReconnectPayload === 'object', 'TS reconnect first frame missing JSON payload');
      const tsReconnectIds = (Array.isArray(tsReconnectPayload.cardDefinitions) ? tsReconnectPayload.cardDefinitions : [])
        .map((card) => card?.id)
        .filter((cardId) => typeof cardId === 'string')
        .sort();
      const tsExpectedReconnectIds = [...T0_EXPECTED_CARD_IDS, ...tsTempCards.map((card) => card.id)].sort();
      assert(JSON.stringify(tsReconnectIds) === JSON.stringify(tsExpectedReconnectIds),
        `TS reconnect snapshot mismatch: expected ${JSON.stringify(tsExpectedReconnectIds)}, got ${JSON.stringify(tsReconnectIds)}`);
      const tsReconnectChatState = tsReconnectPayload.cardChatsByCardId?.[CHAT_CARD_ID];
      assert(tsReconnectChatState && typeof tsReconnectChatState === 'object', `TS reconnect payload missing cardChatsByCardId.${CHAT_CARD_ID}`);
      assert(JSON.stringify(normalizeHydratedChatMessages(tsReconnectChatState.messages)) === JSON.stringify(tsExpectedChatMessages),
        'TS reconnect cardChatsByCardId hydration mismatch');

      for (const tsCard of tsTempCards) {
        const tsRemoveRes = await httpMcp('manage.remove-card', { card_id: tsCard.id });
        assert(tsRemoveRes.status === 200, `TS manage.remove-card(${tsCard.id}) returned ${tsRemoveRes.status}`);
        assert(tsRemoveRes.data?.status === 'success', `TS manage.remove-card(${tsCard.id}) failed: ${JSON.stringify(tsRemoveRes.data)}`);
      }
      await waitUntil(() => {
        const summary = NS.statusSummary;
        if (summary && summary.card_count === T0_EXPECTED_CARD_IDS.length) return summary;
        return false;
      }, 30_000, 'TS cleanup card_count back to 3');
    } finally {
      tsDeltaClient.close();
    }
    console.log('[TS] ok: one-shot framing, event ids, Last-Event-ID reconnect, ordered board deltas, and initial chat hydration verified');
  }

  // ── T3d: probe-echo chat with one AI-generated attachment ──
  if (skipT3d) {
    console.log('\n=== T3d: skipped (--skip-t3d) ===');
  } else {
    console.log('\n=== T3d: probe-echo chat with AI-generated attachment ===');

    // Ensure chat SSE subscription is active (T3 may have been skipped)
    let t3dOwnedSseClient = false;
    if (!chatSseClient) {
      chatSseClientId = `chat-proto-t3d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      chatSseClient = startSseClient(`${BASE}/sse?clientId=${encodeURIComponent(chatSseClientId)}`, (payload) => {
        captureChatEvents(payload, CHAT_CARD_ID);
      });
      await new Promise((r) => setTimeout(r, 400));
      const t3dSubRes = await httpJson('POST', `${BASE}/cards/${CHAT_CARD_ID}/chats/subscribe-sse`, { clientId: chatSseClientId });
      assert(t3dSubRes.status === 200, `T3d chat subscribe returned ${t3dSubRes.status}`);
      t3dOwnedSseClient = true;
    }

    const t2dBeforeChats = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
    assert(t2dBeforeChats.status === 200, `T3d pre chats returned ${t2dBeforeChats.status}`);
    const t2dBeforeMessages = Array.isArray(t2dBeforeChats.data?.data?.messages) ? t2dBeforeChats.data.data.messages : [];
    const t2dBeforeCount = t2dBeforeMessages.length;

    const t2dBeforeCard = await httpMcp('manage.read-card', { card_id: CHAT_CARD_ID });
    assert(t2dBeforeCard.status === 200, `T3d pre card returned ${t2dBeforeCard.status}`);
    const t2dBeforeFiles = Array.isArray(t2dBeforeCard.data?.data?.[0]?.card_data?.files)
      ? t2dBeforeCard.data.data[0].card_data.files
      : [];

    const t3dTurnId = randomTurnId();
    const t2dPrompt = `probe generated attachment validation ${Date.now()}`;
    const t2dEventStart = NS.chatEvents.length;
    const t2dSendRes = await httpJson('POST', `${BASE}/mcp-actions`, {
      tool: 'chat-send',
      args: {
        card_id: CHAT_CARD_ID,
        payload: {
          text: `${ECHO_PROBE_MARKER}echoattach__ ${t2dPrompt}${ECHO_PROBE_MARKER}`,
          'turn-id': t3dTurnId,
        },
      },
    });
    assert(t2dSendRes.status === 200, `T3d chat-send returned ${t2dSendRes.status}`);

    const t2dLifecycle = await waitForChatPredicate((events) => {
      return matchOrderedProbeLifecycle(events.slice(t2dEventStart), {
        beforeCount: t2dBeforeCount,
        beforeProcessing: false,
        prompt: t2dPrompt,
        assistantText: `Echo: ${t2dPrompt}`,
        inProgressText: PROBE_IN_PROGRESS_TEXT,
      });
    }, 60_000, 'T3d ordered lifecycle');
    assert(!!t2dLifecycle, 'T3d ordered lifecycle not observed');

    const t2dAfter = await httpMcp('inspect.chat-messages-on-cards', { card_id: CHAT_CARD_ID, all_turns: true });
    assert(t2dAfter.status === 200, `T3d post chats returned ${t2dAfter.status}`);
    const t2dAfterMessages = Array.isArray(t2dAfter.data?.data?.messages) ? t2dAfter.data.data.messages : [];
    const t2dNewMessages = t2dAfterMessages.slice(t2dBeforeCount);
    assert(t2dNewMessages.length >= 3, `T3d expected at least 3 chat messages after send, got ${t2dNewMessages.length}`);

    const t2dUser = t2dNewMessages.find((m) => m?.role === 'user');
    const t2dInProgress = t2dNewMessages.find((m) => m?.role === 'system' && String(m?.text || '').trim().toLowerCase() === PROBE_IN_PROGRESS_TEXT);
    const t2dAiGenerated = t2dNewMessages.find((m) => m?.role === 'system' && /^AI generated:/i.test(String(m?.text || '')));
    const t2dAssistantMsg = t2dNewMessages.find((m) => m?.role === 'assistant');

    assert(!!t2dUser && typeof t2dUser.id === 'string', 'T3d missing user chat message');
    assert(!!t2dAiGenerated && typeof t2dAiGenerated.id === 'string', 'T3d missing AI-generated attachment system chat message');
    assert(/#\d+\s*$/.test(String(t2dAiGenerated?.text || '')), 'T3d AI-generated system message should include merged file index');
    assert(String(t2dAiGenerated?.turn || '') === t3dTurnId, 'T3d AI-generated system turn id mismatch');
    assert(!!t2dAssistantMsg && typeof t2dAssistantMsg.id === 'string', 'T3d missing assistant chat message');
    assert(String(t2dAssistantMsg?.text || '').includes(`Echo: ${t2dPrompt}`), 'T3d assistant content mismatch');
    assert(String(t2dAssistantMsg?.turn || '') === t3dTurnId, 'T3d assistant turn id mismatch');

    const t2dFileIndexMatch = /#(\d+)\s*$/.exec(String(t2dAiGenerated?.text || ''));
    assert(!!t2dFileIndexMatch, 'T3d AI-generated message missing file index');
    const t2dFileIndex = Number.parseInt(t2dFileIndexMatch[1], 10);
    assert(Number.isInteger(t2dFileIndex) && t2dFileIndex >= 0, 'T3d AI-generated message file index should be non-negative');

    const t2dAfterCard = await httpMcp('manage.read-card', { card_id: CHAT_CARD_ID });
    assert(t2dAfterCard.status === 200, `T3d post card returned ${t2dAfterCard.status}`);
    const t2dAfterFiles = Array.isArray(t2dAfterCard.data?.data?.[0]?.card_data?.files)
      ? t2dAfterCard.data.data[0].card_data.files
      : [];
    assert(t2dAfterFiles.length === t2dBeforeFiles.length + 1, `T3d expected exactly one new stored file, got ${t2dAfterFiles.length - t2dBeforeFiles.length}`);
    const t2dStoredFile = t2dAfterFiles[t2dFileIndex];
    assert(!!t2dStoredFile, `T3d stored file missing at merged index ${t2dFileIndex}`);
    assert(t2dStoredFile?.chat === true, 'T3d generated file should be marked as chat-origin');
    assert(String(t2dStoredFile?.stored_name || '').length > 0, 'T3d generated file stored_name missing');
    assert(!Object.prototype.hasOwnProperty.call(t2dStoredFile || {}, 'path'), 'T3d stored file metadata should not expose path');
    console.log('[T3d] ok: probe staged one AI-generated attachment and appended the final reply through the shared flow');
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

    let t4StatusBeforeRemove = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      t4StatusBeforeRemove = expectMcpSuccess(
        await httpMcp('inspect.board-runtime-status', {}),
        'T4.remove-card board-runtime-status before remove',
      );
      const cards = Array.isArray(t4StatusBeforeRemove?.cards) ? t4StatusBeforeRemove.cards : [];
      if (cards.some(c => c['card-id'] === T4_REMOVE_CARD_ID)) break;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
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
      await httpMcpControlplane('setstate.card-private', { board_id: BOARD_ID, card_id: T5_CARD_ID, key: 'chat.foundry_thread_id', value: t5ThreadId }),
      'T5 setstate.card-private',
    );
    const t5GetMeta = expectMcpSuccess(
      await httpMcpControlplane('getstate.card-private', { board_id: BOARD_ID, card_id: T5_CARD_ID, key: 'chat.foundry_thread_id' }),
      'T5 getstate.card-private',
    );
    assert(t5GetMeta?.exists === true && t5GetMeta?.value === t5ThreadId, `T5 getstate.card-private mismatch: ${JSON.stringify(t5GetMeta)}`);

    const t5ReadCards = expectMcpSuccess(
      await httpMcp('manage.read-card', { card_id: T5_CARD_ID }),
      'T5 manage.read-card meta-redaction',
    );
    const t5ReadCard = Array.isArray(t5ReadCards) ? t5ReadCards[0] : null;
    assert(t5ReadCard && t5ReadCard.__private === undefined, 'T5 expected manage.read-card to redact __private');

    const t5Inspect = expectMcpSuccess(
      await httpMcp('inspect.card-definition-and-runtime', { card_id: T5_CARD_ID }),
      'T5 inspect.card-definition-and-runtime meta-redaction',
    );
    assert(t5Inspect?.card_definition_and_static_data?.__private === undefined, 'T5 expected inspect to redact card_definition_and_static_data.__private');
    console.log('[T5] ok: regular /mcp surfaces redact __private');

    // ── T5: admin-only card round-trip ──────────────────────────────────────
    // 1. Read the existing card definition via the normal read-card path.
    const t5AdminCardId = T5_CARD_ID;
    const t5NormalRead = expectMcpSuccess(
      await httpMcp('manage.read-card', { card_id: t5AdminCardId }),
      'T5 admin setup: manage.read-card before marking admin',
    );
    const t5OriginalCard = Array.isArray(t5NormalRead) ? t5NormalRead[0] : null;
    assert(t5OriginalCard, 'T5 expected card definition before marking as admin-only');

    // 2. Upsert it as an admin-only card via the controlplane tool.
    const t5AdminUpsert = expectMcpSuccess(
      await httpMcpControlplane('manage.admin-upsert-card', {
        board_id: BOARD_ID,
        card_id: t5AdminCardId,
        candidate_card_content: t5OriginalCard,
      }),
      'T5 manage.admin-upsert-card',
    );
    assert(t5AdminUpsert?.board_result, 'T5 expected board_result from admin upsert');
    console.log('[T5] ok: manage.admin-upsert-card succeeded');

    // 3. Verify the card is still readable by known id on the regular /mcp surface
    // (control-plane-only cards are only hidden from *listings*; a by-id read is
    // allowed, with __private redacted).
    const t5HiddenRead = expectMcpSuccess(
      await httpMcp('manage.read-card', { card_id: t5AdminCardId }),
      'T5 manage.read-card by id for control-plane-only card',
    );
    const t5HiddenCard = Array.isArray(t5HiddenRead) ? t5HiddenRead[0] : null;
    assert(t5HiddenCard, `T5 expected manage.read-card to return the control-plane-only card by id, got: ${JSON.stringify(t5HiddenRead)}`);
    assert(t5HiddenCard.__private === undefined,
      `T5 expected __private to be redacted on regular /mcp read, got: ${JSON.stringify(t5HiddenCard.__private)}`);
    console.log('[T5] ok: manage.read-card by id allowed for control-plane-only card (__private redacted)');

    // 3b. Verify the card IS excluded from regular /mcp listings (board-runtime-status).
    const t5Listing = expectMcpSuccess(
      await httpMcp('inspect.board-runtime-status', {}),
      'T5 inspect.board-runtime-status listing',
    );
    const t5ListedIds = Array.isArray(t5Listing?.cards) ? t5Listing.cards.map((c: any) => c?.['card-id']) : [];
    assert(!t5ListedIds.includes(t5AdminCardId),
      `T5 expected control-plane-only card to be excluded from board-runtime-status listing, got ids: ${JSON.stringify(t5ListedIds)}`);
    console.log('[T5] ok: control-plane-only card excluded from regular /mcp listing');

    // 4. Verify the card IS visible via the controlplane admin-read-card tool.
    const t5AdminRead = expectMcpSuccess(
      await httpMcpControlplane('manage.admin-read-card', { board_id: BOARD_ID, card_id: t5AdminCardId }),
      'T5 manage.admin-read-card',
    );
    const t5AdminCards = Array.isArray(t5AdminRead?.cards) ? t5AdminRead.cards : [];
    assert(t5AdminCards.length > 0, 'T5 expected admin-read-card to return the card');
    assert(t5AdminCards[0]?.__private?.visible_controlplane_only === true, `T5 expected __private.visible_controlplane_only=true, got: ${JSON.stringify(t5AdminCards[0]?.__private)}`);
    console.log('[T5] ok: manage.admin-read-card returns card with __private.visible_controlplane_only=true');

    // 5. Guard: setstate.card-private must block changing the flag to a different value.
    const t5MetaGuard = await httpMcpControlplane('setstate.card-private', {
      board_id: BOARD_ID,
      card_id: t5AdminCardId,
      key: 'chat.visible_controlplane_only',
      value: false,  // differs from current flag value (true) → must be rejected
    });
    assert(t5MetaGuard?.status !== 200,
      `T5 expected setstate.card-private to reject changing visible_controlplane_only, got: ${JSON.stringify(t5MetaGuard)}`);
    console.log('[T5] ok: setstate.card-private blocked flag mutation (false != true)');

    // 6. Guard: same key with value matching the current flag (true) must pass (idempotent).
    const t5MetaIdempotent = expectMcpSuccess(
      await httpMcpControlplane('setstate.card-private', {
        board_id: BOARD_ID,
        card_id: t5AdminCardId,
        key: 'chat.visible_controlplane_only',
        value: true,  // matches current flag value → idempotent, allowed
      }),
      'T5 setstate.card-private idempotent same-value',
    );
    assert(t5MetaIdempotent, 'T5 expected setstate.card-private to succeed with matching flag value');
    console.log('[T5] ok: setstate.card-private idempotent same-value allowed');
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
  if (boardSseClient) boardSseClient.close();
  await stopChildProcess(serverProc, 'demo board server');

  // Clean up the test setup directory
  if (fs.existsSync(SETUP_DIR)) {
    fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  }
  console.log('[demo-http-test] server stopped, setup dir cleaned');
}
