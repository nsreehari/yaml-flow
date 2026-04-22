#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const PORT = Number(process.env.DEMO_SERVER_PORT || 7799);
const BOARD_DIR = path.resolve(process.env.DEMO_BOARD_RUNTIME_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-board'));
const CARDS_DIR = path.join(__dirname, 'cards');
const TMP_SURFACE_DIR = path.resolve(process.env.DEMO_SURFACE_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-surface'));
const TMP_CARDS_DIR = path.join(TMP_SURFACE_DIR, 'tmp-cards');
const RUNTIME_OUT_DIR = path.resolve(process.env.DEMO_RUNTIME_OUT_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-runtime-out'));
const STATUS_SNAPSHOT_FILE = path.join(RUNTIME_OUT_DIR, 'board-livegraph-status.json');
const BOARD_FILE = path.join(BOARD_DIR, 'board-graph.json');
const INVENTORY_FILE = path.join(BOARD_DIR, 'cards-inventory.jsonl');

function resolveCliJsPath() {
  const envOverride = process.env.BOARD_LIVE_CARDS_CLI_JS;
  if (envOverride && fs.existsSync(envOverride)) return envOverride;

  // Repo-dev fallback (current project layout).
  const repoDevPath = path.join(path.resolve(__dirname, '../..'), 'dist', 'cli', 'board-live-cards-cli.js');
  if (fs.existsSync(repoDevPath)) return repoDevPath;

  // Installed package fallback (standalone example-board usage).
  try {
    const pkgJsonPath = require.resolve('yaml-flow/package.json', { paths: [process.cwd(), __dirname] });
    const pkgRoot = path.dirname(pkgJsonPath);
    const pkgCli = path.join(pkgRoot, 'board-live-cards-cli.js');
    if (fs.existsSync(pkgCli)) return pkgCli;

    const pkgDistCli = path.join(pkgRoot, 'dist', 'cli', 'board-live-cards-cli.js');
    if (fs.existsSync(pkgDistCli)) return pkgDistCli;
  } catch {
    // Fall through to final error.
  }

  return null;
}

const CLI_JS = resolveCliJsPath();

let didDemoSetup = false;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

const MAX_STORED_FILE_NAME_LEN = 32;

function ensureCardStorageDirs(cardId) {
  const safeCardId = String(cardId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown-card';
  const cardDir = path.join(TMP_CARDS_DIR, safeCardId);
  const filesDir = path.join(cardDir, 'files');
  const chatsDir = path.join(cardDir, 'chats');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(chatsDir, { recursive: true });
  return { filesDir, chatsDir };
}

function normalizeDisplayFileName(name) {
  const input = String(name || '').trim();
  if (!input) return 'upload.bin';
  const base = path.basename(input);
  return base || 'upload.bin';
}

function normalizeStem(rawStem) {
  const normalized = String(rawStem || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'file';
}

function normalizeExt(rawExt) {
  if (!rawExt || rawExt === '.') return '';
  const extBody = String(rawExt).replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return extBody ? `.${extBody}` : '';
}

function parseLeadingSerial(fileName) {
  const m = String(fileName || '').match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : 0;
}

function nextSerialFromNames(names) {
  let maxSeen = 0;
  for (const name of names) {
    const n = parseLeadingSerial(name);
    if (Number.isFinite(n) && n > maxSeen) maxSeen = n;
  }
  return maxSeen + 1;
}

function buildStoredFileName(displayName, serial) {
  const base = normalizeDisplayFileName(displayName);
  const ext = normalizeExt(path.extname(base));
  const stemRaw = ext ? base.slice(0, -path.extname(base).length) : base;
  const stemNorm = normalizeStem(stemRaw);
  const prefix = `${String(serial).padStart(3, '0')}-`;

  let keepExt = ext;
  let stemBudget = MAX_STORED_FILE_NAME_LEN - prefix.length - keepExt.length;
  if (stemBudget < 1) {
    keepExt = '';
    stemBudget = MAX_STORED_FILE_NAME_LEN - prefix.length;
  }

  const stem = stemNorm.slice(0, Math.max(1, stemBudget));
  let out = `${prefix}${stem}${keepExt}`;
  if (out.length > MAX_STORED_FILE_NAME_LEN) {
    out = out.slice(0, MAX_STORED_FILE_NAME_LEN).replace(/\.$/, '');
  }
  return out;
}

function nextFileSerial(cardId) {
  const names = [];

  try {
    const cardPath = findCardPath(cardId);
    if (cardPath && fs.existsSync(cardPath)) {
      const card = readJson(cardPath);
      const files = card && card.card_data && Array.isArray(card.card_data.files)
        ? card.card_data.files
        : [];
      for (const entry of files) {
        if (entry && typeof entry.stored_name === 'string') names.push(entry.stored_name);
      }
    }
  } catch {
    // Ignore malformed card file and fall back to directory scan.
  }

  const { filesDir } = ensureCardStorageDirs(cardId);
  if (fs.existsSync(filesDir)) {
    for (const entry of fs.readdirSync(filesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      names.push(entry.name);
    }
  }

  return nextSerialFromNames(names);
}

function nextChatStoredName(cardId, role) {
  const { chatsDir } = ensureCardStorageDirs(cardId);
  const names = fs.existsSync(chatsDir)
    ? fs.readdirSync(chatsDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    : [];
  const serial = nextSerialFromNames(names);
  const safeRole = String(role || 'system').toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'system';
  return `${String(serial).padStart(3, '0')}-${safeRole}.txt`;
}

function writeChatRecord(cardId, role, text, files) {
  const now = new Date().toISOString();
  const { chatsDir } = ensureCardStorageDirs(cardId);
  const outName = nextChatStoredName(cardId, role || 'system');
  const outPath = path.join(chatsDir, outName);

  const lines = [];
  const msg = typeof text === 'string' ? text.trim() : '';
  if (msg) lines.push(msg);

  const fileList = Array.isArray(files) ? files : [];
  if (fileList.length) {
    if (lines.length) lines.push('');
    lines.push('files:');
    for (const file of fileList) {
      if (!file || typeof file !== 'object') continue;
      const display = typeof file.name === 'string' ? file.name : 'file';
      const stored = typeof file.stored_name === 'string' ? file.stored_name : '';
      lines.push(stored ? `- ${display} -> ${stored}` : `- ${display}`);
    }
  }

  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf-8');
  return {
    at: now,
    role: role || 'system',
    text: msg,
    files: fileList,
    path: `${cardId}/chats/${outName}`,
  };
}

function clearChatRecords(cardId) {
  const { chatsDir } = ensureCardStorageDirs(cardId);
  clearDirContents(chatsDir);
}

function persistUploadedFile(cardId, requestedName, contentType, buffer) {
  const { filesDir } = ensureCardStorageDirs(cardId);
  const displayName = normalizeDisplayFileName(requestedName);

  let serial = nextFileSerial(cardId);
  let storedName = buildStoredFileName(displayName, serial);
  while (fs.existsSync(path.join(filesDir, storedName))) {
    serial += 1;
    storedName = buildStoredFileName(displayName, serial);
  }

  const targetPath = path.join(filesDir, storedName);
  fs.writeFileSync(targetPath, buffer);

  return {
    name: displayName,
    stored_name: storedName,
    size: buffer.length,
    mime_type: contentType || 'application/octet-stream',
    path: `${cardId}/files/${storedName}`,
    uploaded_at: new Date().toISOString(),
  };
}
function shellQuote(s) {
  return '"' + String(s).replace(/"/g, '\\"') + '"';
}

function ensureBuilt() {
  if (!CLI_JS || !fs.existsSync(CLI_JS)) {
    throw new Error(
      'Unable to locate board-live-cards CLI. Set BOARD_LIVE_CARDS_CLI_JS or install yaml-flow in this project.'
    );
  }
}

function runCli(args) {
  ensureBuilt();
  return execFileSync(process.execPath, [CLI_JS, ...args], {
    cwd: process.cwd(),
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
    if (!fs.existsSync(filePath)) {
      if (cardDefinition.id === 'card-ex-narrative') {
        console.log(`[DEBUG] narrative source file not found: ${filePath}`);
      }
      continue;
    }

    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    try {
      out[sourceDef.bindTo] = JSON.parse(raw);
      if (cardDefinition.id === 'card-ex-narrative') {
        console.log(`[DEBUG] narrative source parsed successfully, bindTo=${sourceDef.bindTo}, type=${typeof out[sourceDef.bindTo]}, length=${String(out[sourceDef.bindTo]).length}`);
      }
    } catch (e) {
      out[sourceDef.bindTo] = raw;
      if (cardDefinition.id === 'card-ex-narrative') {
        console.log(`[DEBUG] narrative source parse failed, using raw, error=${e.message}`);
      }
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
      schema_version: rawArtifact.schema_version || 'v1',
      card_id: rawArtifact.card_id || cardDefinition.id,
      card_data: rawArtifact.card_data && typeof rawArtifact.card_data === 'object' ? rawArtifact.card_data : (cardDefinition.card_data && typeof cardDefinition.card_data === 'object' ? cardDefinition.card_data : {}),
      computed_values: rawArtifact.computed_values && typeof rawArtifact.computed_values === 'object' ? rawArtifact.computed_values : {},
      sources_data: sourcesFromFiles,
      requires_data: rawArtifact.requires_data && typeof rawArtifact.requires_data === 'object' ? rawArtifact.requires_data : {},
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
    } else if (Array.isArray(patch._stagedFiles) && patch._stagedFiles.length > 0) {
      // Ignore transient staged file metadata for server mode; real files are
      // persisted through POST /cards/:id/files and attached via action payloads.
      // Never write zero-byte placeholders.
      return card;
    } else {
      // General card patch: merge each top-level key into the card
      for (const [key, value] of Object.entries(patch)) {
        if (key === '_stagedFiles') continue; // never persist staging state to card JSON
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

function applyCardAction(cardId, actionType, payload) {
  update_card(cardId, (card) => {
    const now = new Date().toISOString();
    const cardData = card.card_data && typeof card.card_data === 'object' ? card.card_data : {};
    card.card_data = cardData;

    if (actionType === 'chat-send') {
      const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
      const files = Array.isArray(payload && payload.files)
        ? payload.files
            .map((f) => {
              if (!f) return null;
              if (typeof f === 'string') return { name: f };
              if (typeof f === 'object' && typeof f.name === 'string') {
                return {
                  name: f.name,
                  size: f.size || null,
                  mime_type: f.mime_type || null,
                  path: f.path || null,
                  uploaded_at: f.uploaded_at || null,
                };
              }
              return null;
            })
            .filter(Boolean)
        : [];

      if (text || files.length > 0) {
        writeChatRecord(cardId, 'user', text, files);
        for (const file of files) {
          if (!file || typeof file !== 'object') continue;
          const display = typeof file.name === 'string' ? file.name : 'file';
          const stored = typeof file.stored_name === 'string' ? file.stored_name : null;
          if (!stored) continue;
          writeChatRecord(cardId, 'system', `File ${display} uploaded as ${stored}.`, []);
        }
      }

      return card;
    }

    if (actionType === 'file-upload') {
      const files = Array.isArray(payload && payload.files)
        ? payload.files
            .map((f) => {
              if (!f || typeof f !== 'object') return null;
              if (typeof f.stored_name !== 'string') return null;
              return {
                name: typeof f.name === 'string' ? f.name : f.stored_name,
                stored_name: f.stored_name,
                size: f.size || null,
                mime_type: f.mime_type || null,
                path: f.path || null,
                uploaded_at: f.uploaded_at || now,
              };
            })
            .filter(Boolean)
        : [];

      if (files.length > 0) {
        const existing = Array.isArray(cardData.files) ? cardData.files.slice() : [];
        const known = new Set(existing.map((f) => f && f.stored_name ? f.stored_name : ''));
        for (const f of files) {
          if (known.has(f.stored_name)) continue;
          existing.push(f);
          known.add(f.stored_name);
        }
        cardData.files = existing;
      }

      return card;
    }

    if (actionType === 'action') {
      const buttonId = payload && typeof payload.buttonId === 'string' ? payload.buttonId : '';
      if (!buttonId) return card;

      cardData.lastAction = { buttonId, at: now };
      cardData.lastActionText = `${buttonId} @ ${now}`;
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

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
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

    const cardActionMatch = p.match(/^\/api\/example-board\/server\/cards\/([^/]+)\/actions$/);
    if (method === 'POST' && cardActionMatch) {
      bootstrapBoard();
      const cardId = decodeURIComponent(cardActionMatch[1]);
      const body = await readJsonBody(req);
      applyCardAction(cardId, body && body.actionType, body && body.payload);
      json(res, 200, { ok: true });
      return;
    }

    const cardFileMatch = p.match(/^\/api\/example-board\/server\/cards\/([^/]+)\/files$/);
    if (method === 'POST' && cardFileMatch) {
      bootstrapBoard();
      const cardId = decodeURIComponent(cardFileMatch[1]);
      const encodedName = req.headers['x-file-name'];
      const contentType = String(req.headers['content-type'] || 'application/octet-stream');
      const rawName = Array.isArray(encodedName) ? encodedName[0] : encodedName;
      const requestedName = rawName ? decodeURIComponent(String(rawName)) : 'upload.bin';
      const body = await readRawBody(req);
      if (!body.length) {
        json(res, 400, { error: 'Empty upload body' });
        return;
      }

      const file = persistUploadedFile(cardId, requestedName, contentType, body);
      json(res, 200, { ok: true, file });
      return;
    }

    const cardFileDownloadMatch = p.match(/^\/api\/example-board\/server\/cards\/([^/]+)\/files\/(\d+)$/);
    if (method === 'GET' && cardFileDownloadMatch) {
      const cardId = decodeURIComponent(cardFileDownloadMatch[1]);
      const idx = parseInt(cardFileDownloadMatch[2], 10);
      const expectedStoredName = url.searchParams.get('sn');
      
      // Load card to get files array
      const cardPath = path.join(TMP_CARDS_DIR, `${cardId}.json`);
      if (!fs.existsSync(cardPath)) {
        json(res, 404, { error: 'Card not found' });
        return;
      }
      
      let card;
      try {
        card = readJson(cardPath);
      } catch {
        json(res, 404, { error: 'Card not found' });
        return;
      }
      
      const files = (card.card_data && Array.isArray(card.card_data.files)) ? card.card_data.files : [];
      if (idx < 0 || idx >= files.length) {
        json(res, 404, { error: 'File not found' });
        return;
      }
      
      const fileRecord = files[idx];
      if (!fileRecord || !fileRecord.stored_name) {
        json(res, 404, { error: 'File not found' });
        return;
      }
      if (expectedStoredName && expectedStoredName !== fileRecord.stored_name) {
        json(res, 409, { error: 'File reference is stale. Refresh and try again.' });
        return;
      }
      
      const { filesDir } = ensureCardStorageDirs(cardId);
      const filePath = path.join(filesDir, fileRecord.stored_name);
      
      // Security: prevent directory traversal
      const realPath = path.resolve(filePath);
      const realFilesDir = path.resolve(filesDir);
      if (!realPath.startsWith(realFilesDir)) {
        json(res, 403, { error: 'Forbidden' });
        return;
      }

      if (!fs.existsSync(filePath)) {
        json(res, 404, { error: 'File not found' });
        return;
      }

      const buffer = fs.readFileSync(filePath);
      const filename = fileRecord.name || path.basename(filePath);
      const mimeType = fileRecord.mime_type || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length,
      });
      res.end(buffer);
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
    console.log('  POST  /api/example-board/server/cards/:id/actions');
    console.log('  POST  /api/example-board/server/cards/:id/files');
    console.log('  GET   /api/example-board/server/cards/:id/files/:idx');
  });
}

main();
