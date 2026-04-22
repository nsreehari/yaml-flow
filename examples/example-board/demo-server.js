#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const PORT = Number(process.env.DEMO_SERVER_PORT || 7799);
const BOARD_DIR = path.resolve(process.env.DEMO_BOARD_RUNTIME_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-board'));
const CARDS_DIR = path.join(__dirname, 'cards');
const TMP_SURFACE_DIR = path.resolve(process.env.DEMO_SURFACE_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-surface'));
const TMP_CARDS_DIR = path.join(TMP_SURFACE_DIR, 'tmp-cards');
const RUNTIME_OUT_DIR = path.resolve(process.env.DEMO_RUNTIME_OUT_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-runtime-out'));
const STATUS_SNAPSHOT_FILE = path.join(RUNTIME_OUT_DIR, 'board-livegraph-status.json');
const BOARD_FILE = path.join(BOARD_DIR, 'board-graph.json');
const INVENTORY_FILE = path.join(BOARD_DIR, 'cards-inventory.jsonl');
const CLI_JS = path.join(repoRoot, 'dist', 'cli', 'board-live-cards-cli.js');

let didDemoSetup = false;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

function shellQuote(s) {
  return '"' + String(s).replace(/"/g, '\\"') + '"';
}

function ensureBuilt() {
  if (!fs.existsSync(CLI_JS)) {
    throw new Error(`Missing CLI build at ${CLI_JS}. Run \"npm run build\" in yaml-flow first.`);
  }
}

function runCli(args) {
  ensureBuilt();
  return execFileSync(process.execPath, [CLI_JS, ...args], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
}

function clearDirContents(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(dirPath, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readInventory() {
  if (!fs.existsSync(INVENTORY_FILE)) return [];
  return fs
    .readFileSync(INVENTORY_FILE, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

function statusSnapshotMtimeMs() {
  if (!fs.existsSync(STATUS_SNAPSHOT_FILE)) return 0;
  return fs.statSync(STATUS_SNAPSHOT_FILE).mtimeMs || 0;
}

function readStatusSnapshot() {
  if (!fs.existsSync(STATUS_SNAPSHOT_FILE)) return null;
  return readJson(STATUS_SNAPSHOT_FILE);
}

function readCardDefinitions() {
  const inv = readInventory();
  const out = [];
  for (const entry of inv) {
    if (!entry || !entry.cardId || !entry.cardFilePath) continue;
    if (!fs.existsSync(entry.cardFilePath)) continue;
    out.push(readJson(entry.cardFilePath));
  }
  return out;
}

function readCardRuntimeArtifacts() {
  const cardsDir = path.join(RUNTIME_OUT_DIR, 'cards');
  if (!fs.existsSync(cardsDir)) return {};

  const out = {};
  for (const entry of fs.readdirSync(cardsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.computed.json')) continue;
    const cardId = entry.name.slice(0, -'.computed.json'.length);
    out[cardId] = readJson(path.join(cardsDir, entry.name));
  }
  return out;
}

function readSourcePayloads(cardDefinition) {
  const out = {};
  if (!cardDefinition || !Array.isArray(cardDefinition.sources)) return out;

  for (const sourceDef of cardDefinition.sources) {
    if (!sourceDef || !sourceDef.bindTo || !sourceDef.outputFile) continue;
    const filePath = path.join(BOARD_DIR, sourceDef.outputFile);
    if (!fs.existsSync(filePath)) continue;

    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    try {
      out[sourceDef.bindTo] = JSON.parse(raw);
    } catch {
      out[sourceDef.bindTo] = raw;
    }
  }

  return out;
}

function readDataObjectsByToken() {
  const dirPath = path.join(RUNTIME_OUT_DIR, 'data-objects');
  if (!fs.existsSync(dirPath)) return {};

  const out = {};
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const token = entry.name;
    const filePath = path.join(dirPath, entry.name);
    try {
      out[token] = readJson(filePath);
    } catch {
      // Ignore malformed token files and continue publishing the rest.
    }
  }

  return out;
}

function buildPublishedRuntimePayload() {
  const cardDefinitions = readCardDefinitions();
  const rawArtifacts = readCardRuntimeArtifacts();
  const dataObjectsByToken = readDataObjectsByToken();
  const cardRuntimeById = {};

  for (const cardDefinition of cardDefinitions) {
    if (!cardDefinition || !cardDefinition.id) continue;
    const rawArtifact = rawArtifacts[cardDefinition.id] || {};
    const sourcesFromFiles = readSourcePayloads(cardDefinition);
    cardRuntimeById[cardDefinition.id] = {
      ...rawArtifact,
      schema_version: rawArtifact.schema_version || 'v1',
      card_id: rawArtifact.card_id || cardDefinition.id,
      card_data: cardDefinition.card_data && typeof cardDefinition.card_data === 'object' ? cardDefinition.card_data : {},
      computed_values: rawArtifact.computed_values && typeof rawArtifact.computed_values === 'object' ? rawArtifact.computed_values : {},
      sources_data: sourcesFromFiles,
    };
  }

  return {
    cardDefinitions,
    statusSnapshot: readStatusSnapshot(),
    dataObjectsByToken,
    cardRuntimeById,
  };
}

function demo_prep_setup() {
  fs.mkdirSync(TMP_SURFACE_DIR, { recursive: true });
  fs.rmSync(TMP_CARDS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_CARDS_DIR, { recursive: true });

  const entries = fs.readdirSync(CARDS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.json')) continue;
    const src = path.join(CARDS_DIR, entry.name);
    const dst = path.join(TMP_CARDS_DIR, entry.name);
    fs.copyFileSync(src, dst);
  }

  didDemoSetup = true;
}

function ensureDemoSetup() {
  if (didDemoSetup && fs.existsSync(TMP_CARDS_DIR)) return;
  demo_prep_setup();
}

function initBoard() {
  fs.mkdirSync(BOARD_DIR, { recursive: true });

  const taskExecutorPath = path.join(__dirname, 'demo-task-executor.js');
  const taskExecutorCmd = `${shellQuote(process.execPath)} ${shellQuote(taskExecutorPath)}`;

  try {
    runCli([
      'init',
      BOARD_DIR,
      '--task-executor',
      taskExecutorCmd,
      '--runtime-out',
      RUNTIME_OUT_DIR,
    ]);
  } catch (err) {
    const msg = String(err && err.message || err);
    if (!msg.includes('no valid board-graph.json')) throw err;

    // Recover from partially-created temp board dirs left from previous runs.
    clearDirContents(BOARD_DIR);
    fs.mkdirSync(BOARD_DIR, { recursive: true });
    runCli([
      'init',
      BOARD_DIR,
      '--task-executor',
      taskExecutorCmd,
      '--runtime-out',
      RUNTIME_OUT_DIR,
    ]);
  }
}

function bootstrapBoard() {
  ensureDemoSetup();

  if (!fs.existsSync(BOARD_FILE)) {
    initBoard();
  }

  // Recover from stale inventory mappings when tmp surface location changes
  // (for example from .demo-surface to OS temp dir).
  const expectedCardsRoot = path.resolve(TMP_CARDS_DIR);
  const hasStaleMapping = readInventory().some((entry) => {
    if (!entry || !entry.cardFilePath) return false;
    const mapped = path.resolve(entry.cardFilePath);
    return !mapped.startsWith(expectedCardsRoot + path.sep) && mapped !== expectedCardsRoot;
  });

  if (hasStaleMapping) {
    clearDirContents(BOARD_DIR);
    initBoard();
  }

  runCli(['upsert-card', '--rg', BOARD_DIR, '--card-glob', path.join(TMP_CARDS_DIR, '*.json')]);
}

function findCardPath(cardId) {
  const inv = readInventory();
  const found = inv.find(e => e.cardId === cardId);
  return found ? found.cardFilePath : null;
}

function update_card(cardId, updateFn) {
  const cardPath = findCardPath(cardId);
  if (!cardPath || !fs.existsSync(cardPath)) {
    const err = new Error(`Card not found: ${cardId}`);
    err.statusCode = 404;
    throw err;
  }

  const card = readJson(cardPath);
  const nextCard = updateFn(card) || card;
  fs.writeFileSync(cardPath, JSON.stringify(nextCard, null, 2));

  // Upsert updated card and restart the task.
  runCli(['upsert-card', '--rg', BOARD_DIR, '--card', cardPath, '--restart']);
}

// Deep-merge patch into card: any top-level key in patch is merged into the
// corresponding card field. Nested objects are shallow-merged one level deep.
// Special case: if patch contains fieldValues, resolve writeTo from card view
// elements and set that path directly (form/filter submission pattern).
function patchCard(cardId, patch) {
  update_card(cardId, (card) => {
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return card; // empty patch → just restart via upsert-card --restart
    }

    function deepSet(obj, dottedPath, value) {
      const parts = String(dottedPath || '').split('.').filter(Boolean);
      if (!parts.length) return;
      let target = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (!target[key] || typeof target[key] !== 'object') target[key] = {};
        target = target[key];
      }
      target[parts[parts.length - 1]] = value;
    }

    if (patch.fieldValues && typeof patch.fieldValues === 'object') {
      // Form/filter submission: honour writeTo from the view element definition
      let writeTo = null;
      if (card.view && Array.isArray(card.view.elements)) {
        for (const elem of card.view.elements) {
          if (elem && elem.data && elem.data.writeTo) { writeTo = elem.data.writeTo; break; }
        }
      }
      if (writeTo) {
        deepSet(card, writeTo, patch.fieldValues);
      } else {
        card.card_data = { ...(card.card_data || {}), ...patch.fieldValues };
      }
    } else {
      // General card patch: merge each top-level key into the card
      for (const [key, value] of Object.entries(patch)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
            card[key] !== null && typeof card[key] === 'object' && !Array.isArray(card[key])) {
          card[key] = { ...card[key], ...value };
        } else {
          card[key] = value;
        }
      }
    }

    return card;
  });
}


function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function handleSse(req, res) {
  res.writeHead(200, {
    ...CORS_HEADERS,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const stablePayloadString = (payload) => JSON.stringify(payload, (key, value) => {
    // Exclude volatile runtime clocks that change every tick and cause UI re-renders.
    if (key === 'status_age_ms') return undefined;
    return value;
  });

  let lastPublishedHash = '';

  const emitCards = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const initialPayload = buildPublishedRuntimePayload();
  lastPublishedHash = stablePayloadString(initialPayload);
  emitCards(initialPayload);

  const poll = setInterval(() => {
    try {
      // Keep driving the event graph so dependent cards progress after bootstrap.
      runCli(['process-accumulated-events', '--rg', BOARD_DIR]);

      const nextPayload = buildPublishedRuntimePayload();
      const nextHash = stablePayloadString(nextPayload);
      if (nextHash !== lastPublishedHash) {
        lastPublishedHash = nextHash;
        emitCards(nextPayload);
      } else {
        res.write(': keepalive\n\n');
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: String(err && err.message || err) })}\n\n`);
    }
  }, 800);

  req.on('close', () => {
    clearInterval(poll);
    res.end();
  });
}

function parseUrl(urlString) {
  const u = new URL(urlString, 'http://localhost');
  return u;
}

async function handleApi(req, res) {
  const method = req.method || 'GET';
  const url = parseUrl(req.url || '/');
  const p = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    if (method === 'GET' && p === '/api/example-board/server/demo-setup') {
      demo_prep_setup();
      json(res, 200, { ok: true, tmpCardsDir: TMP_CARDS_DIR });
      return;
    }

    if (method === 'GET' && p === '/api/example-board/server/bootstrap') {
      bootstrapBoard();
      json(res, 200, buildPublishedRuntimePayload());
      return;
    }

    if (method === 'GET' && p === '/api/example-board/server/sse') {
      bootstrapBoard();
      handleSse(req, res);
      return;
    }

    if (method === 'GET' && p === '/api/example-board/server/board-status') {
      try {
        ensureDemoSetup();
        json(res, 200, buildPublishedRuntimePayload());
      } catch (err) {
        json(res, 500, { error: String(err && err.message || err) });
      }
      return;
    }

    const cardMatch = p.match(/^\/api\/example-board\/server\/cards\/([^/]+)$/);
    if (method === 'PATCH' && cardMatch) {
      bootstrapBoard();
      const cardId = decodeURIComponent(cardMatch[1]);
      const body = await readJsonBody(req);
      patchCard(cardId, body);
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    json(res, statusCode, { error: String(err && err.message || err) });
  }
}

/**
 * External task-executor mode — now delegated to task-executor.js
 * (kept here for reference; see task-executor.js for actual implementation)
 */

function main() {
  const server = http.createServer((req, res) => {
    void handleApi(req, res);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[demo-server] listening on http://127.0.0.1:${PORT}`);
    console.log(`[demo-server] board runtime dir: ${BOARD_DIR}`);
    console.log(`[demo-server] tmp surface dir: ${TMP_SURFACE_DIR}`);
    console.log('[demo-server] endpoints:');
    console.log('  GET   /api/example-board/server/demo-setup');
    console.log('  GET   /api/example-board/server/bootstrap');
    console.log('  GET   /api/example-board/server/sse');
    console.log('  PATCH /api/example-board/server/cards/:id');
  });
}

main();
