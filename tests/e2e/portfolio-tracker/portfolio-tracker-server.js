#!/usr/bin/env node
/**
 * portfolio-tracker-server.js
 *
 * Minimal single-board HTTP server for the portfolio-tracker example.
 * Uses createSingleBoardServerRuntime from yaml-flow/board-live-cards-server-runtime.
 *
 * Cards are seeded inline on first start (if the card store is empty).
 * Task executor: portfolio-tracker-fetch-prices.js (mock-quotes source kind).
 *
 * Usage:
 *   node portfolio-tracker-server.js [--port 7800] [--reset]
 *
 * Endpoints (all under /api/board):
 *   GET  /api/board/init-board
 *   GET  /api/board/sse
 *   GET  /api/board/board-status
 *   PATCH /api/board/cards/:id
 *   POST  /api/board/cards/:id/actions
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSingleBoardServerRuntime } from 'yaml-flow/board-live-cards-server-runtime';
import {
  createFsBoardPlatformAdapter,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 7800;
const RESET = args.includes('--reset');

// ── Paths ──────────────────────────────────────────────────────────────────────
const SETUP_DIR = path.join(os.tmpdir(), 'portfolio-tracker-server');
const RUNTIME_DIR = path.join(SETUP_DIR, 'runtime');
const CARDS_DIR = path.join(SETUP_DIR, 'cards');
const OUTPUTS_DIR = path.join(SETUP_DIR, 'outputs');
const FETCH_PRICES_JS = path.join(__dirname, 'portfolio-tracker-fetch-prices.js');

if (RESET && fs.existsSync(SETUP_DIR)) {
  fs.rmSync(SETUP_DIR, { recursive: true, force: true });
  console.log(`[portfolio-tracker-server] reset: wiped ${SETUP_DIR}`);
}
for (const d of [RUNTIME_DIR, CARDS_DIR, OUTPUTS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// ── Card definitions ───────────────────────────────────────────────────────────
const INITIAL_HOLDINGS = [
  { symbol: 'AAPL', qty: 50 },
  { symbol: 'MSFT', qty: 30 },
];

const INLINE_CARDS = [
  {
    id: 'portfolio-form',
    meta: { title: 'Portfolio Holdings Form' },
    provides: [{ bindTo: 'holdings', ref: 'card_data.holdings' }],
    card_data: { holdings: INITIAL_HOLDINGS },
    view: {
      elements: [
        { kind: 'table', label: 'Holdings',
          data: { bind: 'card_data.holdings', columns: ['symbol', 'qty'] } },
      ],
    },
  },
  {
    id: 'price-fetch',
    meta: { title: 'Fetch Market Prices' },
    requires: ['holdings'],
    provides: [{ bindTo: 'prices', ref: 'computed_values.prices' }],
    card_data: {},
    compute: [
      {
        bindTo: 'prices',
        expr: '$merge($map(requires.holdings, function($h){ { $h.symbol: 100 } }))',
      },
    ],
    view: {
      elements: [
        { kind: 'table', label: 'Market Prices',
          data: { bind: 'computed_values.prices' } },
      ],
    },
  },
  {
    id: 'holdings-table',
    meta: { title: 'Holdings Table' },
    requires: ['holdings', 'prices'],
    provides: [{ bindTo: 'table', ref: 'computed_values.table' }],
    card_data: {},
    compute: [{
      bindTo: 'table',
      expr: '{ "rows": $map(requires.holdings, function($h) { { "symbol": $h.symbol, "qty": $h.qty, "price": $lookup(requires.prices, $h.symbol), "value": $h.qty * $lookup(requires.prices, $h.symbol) } }) }',
    }],
    view: {
      elements: [
        { kind: 'table', label: 'Portfolio Positions',
          data: { bind: 'computed_values.table.rows', columns: ['symbol', 'qty', 'price', 'value'] } },
      ],
    },
  },
  {
    id: 'portfolio-value',
    meta: { title: 'Portfolio Total Value' },
    requires: ['table'],
    provides: [{ bindTo: 'totalValue', ref: 'computed_values.totalValue' }],
    card_data: {},
    compute: [
      { bindTo: 'totalValue', expr: '$sum(requires.table.rows.value)' },
    ],
    view: {
      elements: [
        { kind: 'metric', label: 'Total Portfolio Value',
          data: { bind: 'computed_values.totalValue' } },
      ],
    },
  },
];

// ── Host adapters ──────────────────────────────────────────────────────────────
const NOTIFY_CHANNEL = `yaml-flow-pt-server-${process.pid}`;

function namedPipePath(name) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return path.join(os.tmpdir(), `${name}.sock`);
}

function createNodeSpawnInvocationAdapter() {
  return {
    async invoke(ref, invokeArgs) {
      if (ref.howToRun !== 'local-node') {
        return { dispatched: false, error: `unsupported howToRun: ${ref.howToRun}` };
      }
      const whatToRun = String(ref.whatToRun || '');
      let scriptPath = '';
      if (whatToRun.startsWith('b64:')) {
        try {
          const parsed = parseRef(whatToRun);
          if (parsed.kind === 'fs-path') scriptPath = parsed.value;
        } catch {
          scriptPath = '';
        }
      } else {
        scriptPath = whatToRun;
      }
      if (!scriptPath) return { dispatched: false, error: 'no script path' };
      const extra = Buffer.from(JSON.stringify(invokeArgs)).toString('base64');
      try {
        const proc = spawn(process.execPath, [
          scriptPath,
          '--boardId', String(invokeArgs.boardId || ''),
          '--cardId', String(invokeArgs.cardId || ''),
          '--extraEncJson', extra,
        ], { stdio: 'ignore', windowsHide: true });
        proc.unref();
        return { dispatched: true };
      } catch (err) {
        return { dispatched: false, error: err?.message || String(err) };
      }
    },
  };
}

function createNamedPipeNotificationTransport() {
  return {
    async subscribe(ref, onEvent) {
      if (ref.kind !== 'named-pipe') return () => {};
      const pipePath = ref.value;
      if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
        try { fs.rmSync(pipePath, { force: true }); } catch { /* best-effort */ }
      }
      const server = net.createServer((socket) => {
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf-8');
          while (true) {
            const i = buf.indexOf('\n');
            if (i < 0) break;
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              onEvent(msg?.notification ?? msg);
            } catch { /* ignore malformed lines */ }
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipePath, () => resolve());
      });
      return () => {
        server.close();
        if (process.platform !== 'win32') {
          try { fs.rmSync(pipePath, { force: true }); } catch { /* best-effort */ }
        }
      };
    },
  };
}

// ── Board adapter ──────────────────────────────────────────────────────────────
// cliDir must point to the directory containing board-live-cards-cli.js.
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..', '..');
const YAML_FLOW_CLI_DIR = path.join(YAML_FLOW_ROOT, 'dist', 'cli', 'node');
const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: RUNTIME_DIR }));
const boardAdapter = createFsBoardPlatformAdapter(baseRef, YAML_FLOW_CLI_DIR, { notifyChannel: NOTIFY_CHANNEL });
// In the server context the drain loop is driven in-process.
boardAdapter.requestProcessAccumulated = () => {};

const cardStoreRef = serializeRef({ kind: 'fs-path', value: path.join(CARDS_DIR, 'cards') });
const outputsStoreRef = serializeRef({ kind: 'fs-path', value: path.join(OUTPUTS_DIR, '.outputs') });
const notifyRef = { kind: 'named-pipe', value: namedPipePath(NOTIFY_CHANNEL) };
const taskExecutorRef = {
  howToRun: 'local-node',
  whatToRun: serializeRef({ kind: 'fs-path', value: FETCH_PRICES_JS }),
  meta: 'task-executor',
};

// ── Runtime ────────────────────────────────────────────────────────────────────
const runtime = createSingleBoardServerRuntime({
  apiBasePath: '/api/board',
  boardId: 'portfolio-tracker',
  boards: [{
    label: 'portfolio-tracker',
    boardAdapter,
    baseRef,
    cardStoreRef,
    outputsStoreRef,
    notifyRef,
    taskExecutorRef,
  }],
  invocationAdapter: createNodeSpawnInvocationAdapter(),
  notificationTransport: createNamedPipeNotificationTransport(),
  logger: { info: console.log, warn: console.warn, error: console.error },
  serverUrl: `http://127.0.0.1:${PORT}`,
});

// ── Card store seeding ─────────────────────────────────────────────────────────
const existing = runtime.cardStore.get({});
const isEmpty = existing.status !== 'success' || !existing.data?.cards?.length;
if (isEmpty) {
  runtime.cardStore.set({ body: INLINE_CARDS });
  console.log(`[portfolio-tracker-server] seeded ${INLINE_CARDS.length} cards into card store`);
} else {
  console.log(`[portfolio-tracker-server] card store already populated (${existing.data.cards.length} cards)`);
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  runtime.handleRuntimeApi(req, res, url).then((handled) => {
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }).catch((err) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[portfolio-tracker-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[portfolio-tracker-server] runtime dir: ${RUNTIME_DIR}`);
  console.log(`[portfolio-tracker-server] endpoints:`);
  console.log(`  GET  /api/board/init-board`);
  console.log(`  GET  /api/board/sse`);
  console.log(`  GET  /api/board/board-status`);
  console.log(`  PATCH /api/board/cards/:id`);
  console.log(`  POST  /api/board/cards/:id/actions`);
});
