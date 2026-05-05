import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import {
  createBoardLiveCardsPublic,
  createFsBoardPlatformAdapter,
  createCardStorePublic,
  createCardStore,
  createArtifactsStore,
  createChatArtifactsStore,
  createFileArtifactsStore,
  createCardFileMetadataStore,
  parseRef,
} from './dist/cli/node/fs-board-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const DEFAULT_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

const MAX_STORED_FILE_NAME_LEN = 32;

// Routes handled by the reusable runtime (demo-setup is excluded, handled by host)
export const RUNTIME_ROUTE_PATTERNS = [
  /\/init-board$/,
  /\/bootstrap-cards$/,
  /\/bootstrap$/,
  /\/sse$/,
  /\/board-status$/,
  /\/cards\/[^/]+$/,
  /\/cards\/[^/]+\/actions$/,
  /\/cards\/[^/]+\/chats$/,
  /\/cards\/[^/]+\/files$/,
];

export function isRuntimeRoute(pathname) {
  return RUNTIME_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function parseUrl(urlString) {
  return new URL(urlString, 'http://localhost');
}

/**
 * Merges `extraFields` into the `extra` object inside a `.task-executor` JSON file.
 * No-op if the file doesn't exist or isn't valid JSON.
 */
function refreshTaskExecutorExtra(runtimeDir, extraFields) {
  const taskExecutorFile = path.join(runtimeDir, '.task-executor');
  if (!fs.existsSync(taskExecutorFile)) return;
  try {
    const current = JSON.parse(fs.readFileSync(taskExecutorFile, 'utf-8'));
    const merged = { ...current, extra: { ...(current.extra || {}), ...extraFields } };
    fs.writeFileSync(taskExecutorFile, JSON.stringify(merged, null, 2), 'utf-8');
  } catch {
    // Silently ignore — board will still function, extra is best-effort
  }
}

export function createRuntimeRequestDispatcher(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('runtime is required');
  }

  return async function dispatch(req, res, parsedUrl) {
    const method = req.method || 'GET';
    const url = parsedUrl || runtime.parseUrl(req.url || '/');

    if (method === 'OPTIONS') {
      res.writeHead(204, runtime.corsHeaders);
      res.end();
      return true;
    }

    // Multi-board runtime exposes handleApi; single-board exposes handleRuntimeApi.
    if (typeof runtime.handleApi === 'function') {
      if (await runtime.handleApi(req, res, url)) return true;
    } else {
      if (await runtime.handleRuntimeApi(req, res, url)) return true;
    }

    runtime.json(res, 404, { error: 'Not found' });
    return true;
  };
}

/**
 * createMultiBoardServerRuntime
 *
 * Manages multiple boards under a single DEMO_SETUP_DIR.
 * Directory layout:
 *   setupDir/
 *     board-default/              ← built-in example board
 *       runtime/                  ← board-graph.json, cards-inventory.jsonl
 *       surface/                  ← tmp-cards/
 *       runtime-out/              ← computed artefacts
 *     board-<id>/                 ← any additional board
 *       ...same layout...
 *
 * Routes:
 *   GET  /api/boards                       list registered boards
 *   POST /api/boards  {id, label?}         register a new board
 *   GET  /api/boards/:boardId/demo-setup   (host-handled; runtime exposes performDemoSetup)
 *   GET  /api/boards/:boardId/bootstrap
 *   GET  /api/boards/:boardId/sse
 *   ... (all single-board routes, prefixed with /:boardId/)
 */
export function createMultiBoardServerRuntime(options = {}) {
  const setupDir = path.resolve(
    options.setupDir ||
    process.env.DEMO_SETUP_DIR ||
    path.join(os.tmpdir(), 'board-live-cards-demo-setup')
  );
  const apiBasePath = String(options.apiBasePath || '/api/boards').replace(/\/$/, '');
  const corsHeaders = { ...DEFAULT_CORS_HEADERS, ...(options.corsHeaders || {}) };

  // Source card templates shared by all boards unless overridden per-board in config.
  const defaultCardsDir = path.resolve(
    options.defaultCardsDir || path.join(__dirname, 'cards')
  );
  const configuredServerMetaStoreRef = typeof options.serverMetaStoreRef === 'string'
    && options.serverMetaStoreRef.trim()
    ? options.serverMetaStoreRef.trim()
    : null;
  const serverMetaStoreRef = configuredServerMetaStoreRef || `::fs-path::${setupDir}`;
  const serverMetaArtifacts = createArtifactsStore(
    createFsBoardPlatformAdapter(parseRef(serverMetaStoreRef), __dirname, { suppressSpawn: true })
      .blobStorage('server-meta')
  );
  const boardsRegistryKey = 'boards-config.json';
  const boardServiceCache = new Map();

  fs.mkdirSync(setupDir, { recursive: true });

  function readBoardsConfig() {
    const raw = serverMetaArtifacts.getText(boardsRegistryKey);
    if (!raw) {
      return { boards: [{ id: 'default', label: 'Default Board' }] };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return { boards: [{ id: 'default', label: 'Default Board' }] };
    }
  }

  function writeBoardsConfig(config) {
    serverMetaArtifacts.putText(boardsRegistryKey, JSON.stringify(config, null, 2));
  }

  function safeBoardId(raw) {
    const sanitized = String(raw || '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/^_+|_+$/g, '');
    return sanitized.length > 0 && sanitized.length <= 64 ? sanitized : null;
  }

  function getBoardService(boardId) {
    if (boardServiceCache.has(boardId)) return boardServiceCache.get(boardId);

    const boardRoot = path.join(setupDir, `board-${boardId}`);
    const config = readBoardsConfig();
    const entry = config.boards.find((b) => b.id === boardId) || {};
    const cardsDir = typeof entry.cardsDir === 'string' ? path.resolve(entry.cardsDir) : defaultCardsDir;
    const defaultTaskExecutorPath = typeof entry.taskExecutorPath === 'string'
      ? entry.taskExecutorPath
      : options.defaultTaskExecutorPath;
    const defaultStepMachineCliPath = typeof entry.stepMachineCliPath === 'string'
      ? entry.stepMachineCliPath
      : options.defaultStepMachineCliPath;
    const defaultChatHandlerPath = typeof entry.chatHandlerPath === 'string'
      ? entry.chatHandlerPath
      : options.defaultChatHandlerPath;
    const defaultInferenceAdapterPath = typeof entry.inferenceAdapterPath === 'string'
      ? entry.inferenceAdapterPath
      : options.defaultInferenceAdapterPath;
    const gandalfCardsDir = typeof entry.gandalfCardsDir === 'string'
      ? entry.gandalfCardsDir
      : (options.defaultGandalfCardsDir || null);
    const gandalfTaskExecutorPath = typeof entry.gandalfTaskExecutorPath === 'string'
      ? entry.gandalfTaskExecutorPath
      : (options.defaultGandalfTaskExecutorPath || null);
    const gandalfChatHandlerPath = typeof entry.gandalfChatHandlerPath === 'string'
      ? entry.gandalfChatHandlerPath
      : (options.defaultGandalfChatHandlerPath || null);
    const gandalfInferenceAdapterPath = typeof entry.gandalfInferenceAdapterPath === 'string'
      ? entry.gandalfInferenceAdapterPath
      : (options.defaultGandalfInferenceAdapterPath || null);

    const service = createExampleBoardServerRuntime({
      apiBasePath: `${apiBasePath}/${boardId}`,
      corsHeaders,
      boardId,
      boardDir: path.join(boardRoot, 'runtime'),
      cardsDir,
      tmpSurfaceDir: path.join(boardRoot, 'surface'),
      runtimeOutDir: path.join(boardRoot, 'runtime-out'),
      defaultTaskExecutorPath,
      defaultStepMachineCliPath,
      defaultChatHandlerPath,
      defaultInferenceAdapterPath,
      gandalfCardsDir,
      gandalfRuntimeDir: path.join(boardRoot, 'gandalf-runtime'),
      gandalfRuntimeOutDir: path.join(boardRoot, 'gandalf-runtime-out'),
      gandalfTaskExecutorPath,
      gandalfChatHandlerPath,
      gandalfInferenceAdapterPath,
      boardLiveCardsCliJs: options.boardLiveCardsCliJs,
      serverUrl: options.serverUrl || null,
    });

    boardServiceCache.set(boardId, service);
    return service;
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  async function handleBoardsRegistryApi(req, res, parsedUrl) {
    const method = req.method || 'GET';
    const p = parsedUrl.pathname;

    // GET /api/boards — list boards
    if (method === 'GET' && p === apiBasePath) {
      json(res, 200, { ok: true, boards: readBoardsConfig().boards });
      return true;
    }

    // POST /api/boards {id, label?} — register new board
    if (method === 'POST' && p === apiBasePath) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

      const id = safeBoardId(body.id);
      if (!id) {
        json(res, 400, { error: 'board id must be 1-64 alphanumeric/dash/underscore characters' });
        return true;
      }

      const config = readBoardsConfig();
      if (config.boards.some((b) => b.id === id)) {
        json(res, 409, { error: `Board "${id}" is already registered` });
        return true;
      }

      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : id;
      const entry = { id, label };
      if (typeof body.cardsDir === 'string') entry.cardsDir = body.cardsDir;
      if (typeof body.stepMachineCliPath === 'string') entry.stepMachineCliPath = body.stepMachineCliPath;
      if (typeof body.taskExecutorPath === 'string') entry.taskExecutorPath = body.taskExecutorPath;
      if (typeof body.chatHandlerPath === 'string') entry.chatHandlerPath = body.chatHandlerPath;
      if (typeof body.inferenceAdapterPath === 'string') entry.inferenceAdapterPath = body.inferenceAdapterPath;
      config.boards.push(entry);
      writeBoardsConfig(config);

      // Pre-create board directory tree so the board is immediately usable.
      const boardRoot = path.join(setupDir, `board-${id}`);
      fs.mkdirSync(path.join(boardRoot, 'runtime'), { recursive: true });
      fs.mkdirSync(path.join(boardRoot, 'surface'), { recursive: true });
      fs.mkdirSync(path.join(boardRoot, 'runtime-out'), { recursive: true });

      json(res, 200, { ok: true, board: entry });
      return true;
    }

    return false;
  }

  async function handleBoardApi(req, res, parsedUrl) {
    const p = parsedUrl.pathname;

    // Extract boardId from /:boardId/... or /:boardId (exact)
    const boardSegMatch = p.match(new RegExp(`^${apiBasePath}/([^/]+)(/|$)`));
    if (!boardSegMatch) return false;

    const boardId = safeBoardId(decodeURIComponent(boardSegMatch[1]));
    if (!boardId) {
      json(res, 400, { error: 'Invalid board id' });
      return true;
    }

    const config = readBoardsConfig();
    if (!config.boards.some((b) => b.id === boardId)) {
      json(res, 404, {
        error: `Board "${boardId}" not registered. POST ${apiBasePath} with {id} to register it first.`,
      });
      return true;
    }

    const service = getBoardService(boardId);
    if (await service.handleRuntimeApi(req, res, parsedUrl)) return true;
    return false;
  }

  async function handleApi(req, res, parsedUrl) {
    if (await handleBoardsRegistryApi(req, res, parsedUrl)) return true;
    if (await handleBoardApi(req, res, parsedUrl)) return true;
    return false;
  }

  // Exposed so host layers (e.g. demo-server) can reach a board's service and root path.
  // Throws a 404 error if the board is not registered.
  function requireBoardService(boardId) {
    const config = readBoardsConfig();
    if (!config.boards.some((b) => b.id === boardId)) {
      const err = new Error(`Board "${boardId}" not registered`);
      err.statusCode = 404;
      throw err;
    }
    const boardRoot = path.join(setupDir, `board-${boardId}`);
    return { service: getBoardService(boardId), boardRoot };
  }

  return {
    apiBasePath,
    corsHeaders,
    setupDir,
    serverMetaStoreRef,
    boardsRegistryKey,
    parseUrl,
    json,
    handleBoardsRegistryApi,
    handleBoardApi,
    handleApi,
    requireBoardService,
  };
}

export function createNodeHttpRuntimeHandler(runtime) {
  const dispatch = createRuntimeRequestDispatcher(runtime);
  return function nodeHttpHandler(req, res) {
    void dispatch(req, res);
  };
}

export function createExampleBoardServerRuntime(options = {}) {
  const apiBasePath = String(options.apiBasePath || '/api/example-board/server').replace(/\/$/, '');
  const corsHeaders = { ...DEFAULT_CORS_HEADERS, ...(options.corsHeaders || {}) };
  const boardId = typeof options.boardId === 'string' && options.boardId ? options.boardId : '';

  const boardDir = path.resolve(
    options.boardDir || process.env.DEMO_BOARD_RUNTIME_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-board')
  );
  const cardsDir = path.resolve(options.cardsDir || path.join(__dirname, 'cards'));
  const tmpSurfaceDir = path.resolve(
    options.tmpSurfaceDir || process.env.DEMO_SURFACE_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-surface')
  );
  const tmpCardsDir = cardsDir;
  const runtimeOutDir = path.resolve(
    options.runtimeOutDir || process.env.DEMO_RUNTIME_OUT_DIR || path.join(os.tmpdir(), 'board-live-cards-demo-runtime-out')
  );
  const configuredTaskExecutorPath = typeof options.defaultTaskExecutorPath === 'string'
    && options.defaultTaskExecutorPath.trim()
    ? (path.isAbsolute(options.defaultTaskExecutorPath)
      ? options.defaultTaskExecutorPath
      : path.resolve(process.cwd(), options.defaultTaskExecutorPath))
    : null;
  const configuredStepMachineCliPath = typeof options.defaultStepMachineCliPath === 'string'
    && options.defaultStepMachineCliPath.trim()
    ? (path.isAbsolute(options.defaultStepMachineCliPath)
      ? options.defaultStepMachineCliPath
      : path.resolve(process.cwd(), options.defaultStepMachineCliPath))
    : null;
  const configuredBoardLiveCardsCliJs = typeof options.boardLiveCardsCliJs === 'string'
    && options.boardLiveCardsCliJs.trim()
    ? (path.isAbsolute(options.boardLiveCardsCliJs)
      ? options.boardLiveCardsCliJs
      : path.resolve(process.cwd(), options.boardLiveCardsCliJs))
    : null;
  const configuredChatHandlerPath = typeof options.defaultChatHandlerPath === 'string'
    && options.defaultChatHandlerPath.trim()
    ? (path.isAbsolute(options.defaultChatHandlerPath)
      ? options.defaultChatHandlerPath
      : path.resolve(process.cwd(), options.defaultChatHandlerPath))
    : null;
  const configuredInferenceAdapterPath = typeof options.defaultInferenceAdapterPath === 'string'
    && options.defaultInferenceAdapterPath.trim()
    ? (path.isAbsolute(options.defaultInferenceAdapterPath)
      ? options.defaultInferenceAdapterPath
      : path.resolve(process.cwd(), options.defaultInferenceAdapterPath))
    : null;

  // Board-cards: parallel runtime dirs for the board-manager board.
  const gandalfCardsDir = options.gandalfCardsDir ? path.resolve(options.gandalfCardsDir) : null;
  const gandalfRuntimeDir = path.resolve(options.gandalfRuntimeDir || path.join(path.dirname(boardDir), 'gandalf-runtime'));
  const gandalfRuntimeOutDir = path.resolve(options.gandalfRuntimeOutDir || path.join(path.dirname(boardDir), 'gandalf-runtime-out'));
  const tmpGandalfCardsDir = gandalfCardsDir;

  // Explicit gandalf-card executor paths — no fallback to regular-card paths.
  const configuredGandalfTaskExecutorPath = typeof options.gandalfTaskExecutorPath === 'string' && options.gandalfTaskExecutorPath.trim()
    ? (path.isAbsolute(options.gandalfTaskExecutorPath) ? options.gandalfTaskExecutorPath : path.resolve(process.cwd(), options.gandalfTaskExecutorPath))
    : null;
  const configuredGandalfChatHandlerPath = typeof options.gandalfChatHandlerPath === 'string' && options.gandalfChatHandlerPath.trim()
    ? (path.isAbsolute(options.gandalfChatHandlerPath) ? options.gandalfChatHandlerPath : path.resolve(process.cwd(), options.gandalfChatHandlerPath))
    : null;
  const configuredGandalfInferenceAdapterPath = typeof options.gandalfInferenceAdapterPath === 'string' && options.gandalfInferenceAdapterPath.trim()
    ? (path.isAbsolute(options.gandalfInferenceAdapterPath) ? options.gandalfInferenceAdapterPath : path.resolve(process.cwd(), options.gandalfInferenceAdapterPath))
    : null;

  // Server URL passed down from the hosting server (e.g. demo-server) so executors/handlers
  // can call back to server-side proxy endpoints (e.g. /api/workiq/ask).
  const serverUrl = typeof options.serverUrl === 'string' && options.serverUrl.trim()
    ? options.serverUrl.trim().replace(/\/$/, '')
    : null;

  const sseClients = new Set();
  const cardPathById = new Map();
  const gandalfCardPathById = new Map();

  function isGandalfCard(cardId) { return gandalfCardPathById.has(cardId); }

  function namedPipePath(pipeName) {
    if (process.platform === 'win32') return `\\\\.\\pipe\\${pipeName}`;
    return path.join(os.tmpdir(), `${pipeName}.sock`);
  }

  function makeNotificationState() {
    return {
      status: null,
      computedValues: {},
      dataObjects: {},
      cards: {},
      sockets: new Set(),
    };
  }

  function appendNotification(state, event) {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'status') state.status = event.status;
    if (event.kind === 'computed_values' && event.cardId) state.computedValues[event.cardId] = event.values;
    if (event.kind === 'data_object' && event.key) state.dataObjects[event.key] = event.payload;
    if (event.kind === 'card_refreshed' && event.cardId) state.cards[event.cardId] = event.card;
  }

  function makeBoardContext(label, runtimeDir, outputsDir, cardsRootDir, taskExecutorPath, chatHandlerPath, inferenceAdapterPath) {
    const notifyChannel = `yaml-flow-server-${label}-${boardId || 'default'}-${process.pid}`;
    const baseRefStr = `::fs-path::${runtimeDir}`;
    const cardStoreRef = `::fs-path::${path.join(cardsRootDir, 'cards')}`;
    const outputsStoreRef = `::fs-path::${path.join(outputsDir, '.outputs')}`;
    const baseRef = parseRef(baseRefStr);
    const adapter = createFsBoardPlatformAdapter(baseRef, __dirname, {
      onWarn: (msg) => console.warn(`[server-runtime:${label}] ${msg}`),
      suppressSpawn: true,
      notifyChannel,
    });
    const board = createBoardLiveCardsPublic(baseRef, adapter);
    const kv = adapter.kvStorageForRef(cardStoreRef);
    const cardAdapterObj = {
      readIndex: () => kv.read('_index'),
      writeIndex: (idx) => kv.write('_index', idx),
      readCard: (id) => kv.read(id),
      writeCard: (id, card) => { kv.write(id, card); return id; },
      cardExists: (id) => kv.read(id) !== null,
      defaultCardKey: (id) => id,
    };
    const cardStore = createCardStorePublic(createCardStore(cardAdapterObj, console.warn));
    const artifactsRef = parseRef(`::fs-path::${cardsRootDir}`);
    const artifactsAdapter = createFsBoardPlatformAdapter(artifactsRef, __dirname, { suppressSpawn: true });
    const filesArtifacts = createArtifactsStore(artifactsAdapter.blobStorage('files'));
    const chatsArtifacts = createArtifactsStore(artifactsAdapter.blobStorage('chats'));
    return {
      label,
      runtimeDir,
      outputsDir,
      cardsRootDir,
      notifyChannel,
      board,
      cardStore,
      filesArtifacts,
      chatsArtifacts,
      cardStoreRef,
      outputsStoreRef,
      taskExecutorPath,
      chatHandlerPath,
      inferenceAdapterPath,
      notification: makeNotificationState(),
      pipeServer: null,
      initialized: false,
      cardsBootstrapped: false,
    };
  }

  const baseCtx = makeBoardContext(
    'base',
    boardDir,
    runtimeOutDir,
    tmpCardsDir,
    configuredTaskExecutorPath,
    configuredChatHandlerPath,
    configuredInferenceAdapterPath,
  );

  const gandalfCtx = configuredGandalfTaskExecutorPath && tmpGandalfCardsDir
    ? makeBoardContext(
      'gandalf',
      gandalfRuntimeDir,
      gandalfRuntimeOutDir,
      tmpGandalfCardsDir,
      configuredGandalfTaskExecutorPath,
      configuredGandalfChatHandlerPath,
      configuredGandalfInferenceAdapterPath,
    )
    : null;

  function cardFilesFromDir(dirPath, outMap) {
    outMap.clear();
    if (!dirPath || !fs.existsSync(dirPath)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const full = path.join(dirPath, entry.name);
      try {
        const card = JSON.parse(fs.readFileSync(full, 'utf-8'));
        if (!card || typeof card.id !== 'string') continue;
        outMap.set(card.id, full);
        out.push(card);
      } catch {
        // ignore malformed files
      }
    }
    return out;
  }

  function toExecutionRef(scriptPath, extraObj) {
    if (!scriptPath) return null;
    return {
      howToRun: 'local-node',
      whatToRun: `::fs-path::${scriptPath}`,
      extra: extraObj,
    };
  }

  async function ensurePipeConsumer(ctx) {
    if (!ctx || ctx.pipeServer) return;
    const pipePath = namedPipePath(ctx.notifyChannel);
    if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
      try { fs.rmSync(pipePath, { force: true }); } catch { /* best-effort */ }
    }
    const server = net.createServer((socket) => {
      ctx.notification.sockets.add(socket);
      socket.on('close', () => ctx.notification.sockets.delete(socket));
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
            const n = msg?.notification ?? msg;
            appendNotification(ctx.notification, n);
          } catch {
            // ignore malformed lines
          }
        }
        broadcastToSseClients();
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipePath, () => resolve());
    });
    ctx.pipeServer = { server, pipePath };
  }

  function ensureCardStorageDirs(cardId) {
    const safeCardId = String(cardId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown-card';
    const baseDir = isGandalfCard(cardId) ? tmpGandalfCardsDir : tmpCardsDir;
    const filesDir = path.join(baseDir, 'files', safeCardId);
    const chatsDir = path.join(baseDir, 'chats', safeCardId);
    fs.mkdirSync(filesDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    return { filesDir, chatsDir, safeCardId };
  }

  function artifactsStores(cardId) {
    const ctx = isGandalfCard(cardId) ? gandalfCtx : baseCtx;
    return {
      files: ctx ? ctx.filesArtifacts : null,
      chats: ctx ? ctx.chatsArtifacts : null,
    };
  }

  function chatArtifactsForCard(cardId) {
    const stores = artifactsStores(cardId);
    if (!stores.chats) return null;
    return createChatArtifactsStore(stores.chats, { indexFileName: '.index.json' });
  }

  function fileArtifactsForCard(cardId) {
    const stores = artifactsStores(cardId);
    if (!stores.files) return null;
    return createFileArtifactsStore(stores.files);
  }

  function cardFileMetadataStore() {
    return createCardFileMetadataStore();
  }

  function parseLeadingSerial(fileName) {
    const m = String(fileName || '').match(/^(\d+)[-_]/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function normalizeDisplayFileName(name) {
    const input = String(name || '').trim();
    if (!input) return 'upload.bin';
    const base = path.basename(input);
    return base || 'upload.bin';
  }

  function shellQuote(s) {
    return '"' + String(s).replace(/"/g, '\\"') + '"';
  }

  function runCli(_args) {
    throw new Error('CLI path is no longer used by server runtime. Use board public APIs.');
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
    return [...cardPathById.entries()].map(([cardId, cardFilePath]) => ({ cardId, cardFilePath }));
  }

  function readGandalfInventory() {
    return [...gandalfCardPathById.entries()].map(([cardId, cardFilePath]) => ({ cardId, cardFilePath }));
  }

  function readStatusSnapshot() {
    const base = baseCtx.notification.status;
    const side = gandalfCtx ? gandalfCtx.notification.status : null;
    if (!base && !side) return null;
    if (!side) return base;
    if (!base) return side;

    const baseCards = Array.isArray(base.cards) ? base.cards : [];
    const sideCards = Array.isArray(side.cards) ? side.cards : [];
    const mergedCards = [...baseCards, ...sideCards];

    const sum = (obj, k) => Number(obj?.summary?.[k] || 0);
    return {
      ...base,
      cards: mergedCards,
      summary: {
        ...(base.summary || {}),
        card_count: mergedCards.length,
        completed: sum(base, 'completed') + sum(side, 'completed'),
        eligible: sum(base, 'eligible') + sum(side, 'eligible'),
        pending: sum(base, 'pending') + sum(side, 'pending'),
        blocked: sum(base, 'blocked') + sum(side, 'blocked'),
        unresolved: sum(base, 'unresolved') + sum(side, 'unresolved'),
        failed: sum(base, 'failed') + sum(side, 'failed'),
        in_progress: sum(base, 'in_progress') + sum(side, 'in_progress'),
        orphan_cards: sum(base, 'orphan_cards') + sum(side, 'orphan_cards'),
      },
    };
  }

  function readCardDefinitions() {
    const fromCtx = (ctx, fallbackDir, fallbackMap) => {
      if (!ctx || !ctx.cardStore) return cardFilesFromDir(fallbackDir, fallbackMap);
      const result = ctx.cardStore.get({});
      if (result.status !== 'success' || !Array.isArray(result.data?.cards)) {
        return cardFilesFromDir(fallbackDir, fallbackMap);
      }
      return result.data.cards;
    };

    const base = fromCtx(baseCtx, tmpCardsDir, cardPathById);
    const side = gandalfCtx ? fromCtx(gandalfCtx, tmpGandalfCardsDir, gandalfCardPathById) : [];
    return [...base, ...side];
  }

  function readCardRuntimeArtifacts() {
    const out = {};
    for (const [cardId, values] of Object.entries(baseCtx.notification.computedValues)) {
      const card = baseCtx.notification.cards[cardId];
      out[cardId] = {
        schema_version: 'v1',
        card_id: cardId,
        card_data: card?.card_data ?? {},
        computed_values: values ?? {},
        fetched_sources: {},
        requires: {},
      };
    }
    if (gandalfCtx) {
      for (const [cardId, values] of Object.entries(gandalfCtx.notification.computedValues)) {
        const card = gandalfCtx.notification.cards[cardId];
        out[cardId] = {
          schema_version: 'v1',
          card_id: cardId,
          card_data: card?.card_data ?? {},
          computed_values: values ?? {},
          fetched_sources: {},
          requires: {},
        };
      }
    }
    return out;
  }

  function readSourcePayloads(cardDefinition) {
    const out = {};
    if (!cardDefinition || !Array.isArray(cardDefinition.source_defs)) return out;

    const ctx = isGandalfCard(cardDefinition.id) ? gandalfCtx : baseCtx;
    const dataObjects = ctx ? ctx.notification.dataObjects : {};
    for (const sourceDef of cardDefinition.source_defs) {
      if (!sourceDef || !sourceDef.bindTo) continue;
      if (Object.prototype.hasOwnProperty.call(dataObjects, sourceDef.bindTo)) {
        out[sourceDef.bindTo] = dataObjects[sourceDef.bindTo];
      }
    }

    return out;
  }

  function readDataObjectsByToken() {
    return {
      ...(baseCtx.notification.dataObjects || {}),
      ...(gandalfCtx ? gandalfCtx.notification.dataObjects : {}),
    };
  }

  function readChatSignal(cardId) {
    const { safeCardId } = ensureCardStorageDirs(cardId);
    const chatStore = chatArtifactsForCard(cardId);
    if (!chatStore) return { count: 0, latest_mtime_ms: 0, processing: false };
    return chatStore.readSignal(safeCardId);
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
      const chatSignal = readChatSignal(cardDefinition.id);
      cardRuntimeById[cardDefinition.id] = {
        schema_version: rawArtifact.schema_version || 'v1',
        card_id: rawArtifact.card_id || cardDefinition.id,
        card_data:
          rawArtifact.card_data && typeof rawArtifact.card_data === 'object'
            ? rawArtifact.card_data
            : cardDefinition.card_data && typeof cardDefinition.card_data === 'object'
              ? cardDefinition.card_data
              : {},
        computed_values:
          rawArtifact.computed_values && typeof rawArtifact.computed_values === 'object'
            ? rawArtifact.computed_values
            : {},
        fetched_sources: sourcesFromFiles,
        requires:
          rawArtifact.requires && typeof rawArtifact.requires === 'object'
            ? rawArtifact.requires
            : {},
      };

      if (!cardRuntimeById[cardDefinition.id].card_data || typeof cardRuntimeById[cardDefinition.id].card_data !== 'object') {
        cardRuntimeById[cardDefinition.id].card_data = {};
      }
      cardRuntimeById[cardDefinition.id].card_data.__chat_signal = chatSignal;
    }

    return {
      cardDefinitions,
      statusSnapshot: readStatusSnapshot(),
      dataObjectsByToken,
      cardRuntimeById,
    };
  }

  function resolveTaskExecutorPath(taskExecutorPathParam) {
    const raw = typeof taskExecutorPathParam === 'string' ? taskExecutorPathParam.trim() : '';
    const resolved = raw
      ? (path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw))
      : configuredTaskExecutorPath;
    if (!resolved) {
      const err = new Error('taskExecutorPath is required (query param or runtime defaultTaskExecutorPath option)');
      err.statusCode = 400;
      throw err;
    }
    if (!fs.existsSync(resolved)) {
      const err = new Error(`Task executor script not found: ${resolved}`);
      err.statusCode = 400;
      throw err;
    }
    return resolved;
  }

  function resolveChatHandlerPath(chatHandlerPathParam) {
    const raw = typeof chatHandlerPathParam === 'string' ? chatHandlerPathParam.trim() : '';
    const resolved = raw
      ? (path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw))
      : configuredChatHandlerPath;
    if (!resolved) return null;
    if (!fs.existsSync(resolved)) {
      const err = new Error(`Chat handler script not found: ${resolved}`);
      err.statusCode = 400;
      throw err;
    }
    return resolved;
  }

  function resolveInferenceAdapterPath(inferenceAdapterPathParam) {
    const raw = typeof inferenceAdapterPathParam === 'string' ? inferenceAdapterPathParam.trim() : '';
    const resolved = raw
      ? (path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw))
      : configuredInferenceAdapterPath;
    if (!resolved) return null;
    if (!fs.existsSync(resolved)) {
      const err = new Error(`Inference adapter script not found: ${resolved}`);
      err.statusCode = 400;
      throw err;
    }
    return resolved;
  }

  async function initContext(ctx, taskExecutorPathParam, chatHandlerPathParam, inferenceAdapterPathParam) {
    if (!ctx) return;
    if (ctx.initialized) return;

    const te = resolveTaskExecutorPath(taskExecutorPathParam || ctx.taskExecutorPath);
    const ch = resolveChatHandlerPath(chatHandlerPathParam || ctx.chatHandlerPath);
    const ia = resolveInferenceAdapterPath(inferenceAdapterPathParam || ctx.inferenceAdapterPath);
    const boardSetupRoot = path.dirname(boardDir);
    const extra = {
      boardSetupRoot,
      boardId,
      boardRuntimeDir: path.relative(boardSetupRoot, ctx.runtimeDir),
      runtimeStatusDir: path.relative(boardSetupRoot, ctx.outputsDir),
      cardsDir: path.relative(boardSetupRoot, ctx.cardsRootDir),
      ...(serverUrl ? { serverUrl } : {}),
      ...(configuredBoardLiveCardsCliJs ? { boardLiveCardsCliJs: configuredBoardLiveCardsCliJs } : {}),
      ...(configuredStepMachineCliPath ? { stepMachineCliPath: configuredStepMachineCliPath } : {}),
    };

    const params = {
      cardStoreRef: ctx.cardStoreRef,
      outputsStoreRef: ctx.outputsStoreRef,
    };
    const body = {};
    body['task-executor-ref'] = toExecutionRef(te, extra);
    if (ch) body['chat-handler-ref'] = toExecutionRef(ch, extra);
    if (ia) body['inference-adapter-ref'] = toExecutionRef(ia, extra);

    const initResult = ctx.board.init({ params, body });
    if (initResult.status !== 'success') {
      const err = new Error(initResult.error || `init failed for ${ctx.label}`);
      err.statusCode = 500;
      throw err;
    }
    await ensurePipeConsumer(ctx);
    ctx.initialized = true;
  }

  async function upsertCardsFromDir(ctx, outMap) {
    if (!ctx) return;
    if (ctx.cardsBootstrapped) return;
    const cards = cardFilesFromDir(ctx.cardsRootDir, outMap);
    for (const card of cards) {
      const setResult = ctx.cardStore.set({ body: card });
      if (setResult.status !== 'success') continue;
      ctx.board.upsertCard({ params: { cardId: card.id, restart: true } });
    }
    await ctx.board.processAccumulatedEvents({});
    ctx.cardsBootstrapped = true;
  }

  async function initBoardAndSetup(taskExecutorPathParam, chatHandlerPathParam, inferenceAdapterPathParam) {
    await initContext(baseCtx, taskExecutorPathParam, chatHandlerPathParam, inferenceAdapterPathParam);
    if (gandalfCtx && gandalfCtx.taskExecutorPath) {
      await initContext(gandalfCtx, gandalfCtx.taskExecutorPath, gandalfCtx.chatHandlerPath, gandalfCtx.inferenceAdapterPath);
    }
  }

  async function bootstrapBoard() {
    await initBoardAndSetup();
    await upsertCardsFromDir(baseCtx, cardPathById);
    if (gandalfCtx) await upsertCardsFromDir(gandalfCtx, gandalfCardPathById);
  }

  function cardContextForCard(cardId) {
    return isGandalfCard(cardId) ? gandalfCtx : baseCtx;
  }

  function readCardFromStore(cardId) {
    const ctx = cardContextForCard(cardId);
    if (!ctx) return null;
    const result = ctx.cardStore.get({ params: { id: cardId } });
    if (result.status !== 'success') return null;
    const cards = Array.isArray(result.data?.cards) ? result.data.cards : [];
    return cards.length > 0 ? cards[0] : null;
  }

  function mutateCard(cardId, updateFn, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const syncBoard = options.syncBoard !== false;
    const ctx = cardContextForCard(cardId);
    if (!ctx) {
      const err = new Error(`Card not found: ${cardId}`);
      err.statusCode = 404;
      throw err;
    }

    const card = readCardFromStore(cardId);
    if (!card || typeof card !== 'object') {
      const err = new Error(`Card not found: ${cardId}`);
      err.statusCode = 404;
      throw err;
    }

    const nextCard = updateFn(card) || card;
    const setResult = ctx.cardStore.set({ body: nextCard });
    if (setResult.status !== 'success') {
      const err = new Error(setResult.error || `Failed to persist card: ${cardId}`);
      err.statusCode = 500;
      throw err;
    }

    if (syncBoard) {
      const upsertResult = ctx.board.upsertCard({ params: { cardId, restart: true } });
      if (upsertResult.status !== 'success') {
        const err = new Error(upsertResult.error || `Failed to upsert card: ${cardId}`);
        err.statusCode = 500;
        throw err;
      }
    }
  }

  function updateCard(cardId, updateFn) {
    mutateCard(cardId, updateFn, { syncBoard: true });
  }

  function updateCardLocalOnly(cardId, updateFn) {
    mutateCard(cardId, updateFn, { syncBoard: false });
  }

  function patchCard(cardId, patch) {
    updateCard(cardId, (card) => {
      if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
        return card;
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
        let writeTo = null;
        if (card.view && Array.isArray(card.view.elements)) {
          for (const elem of card.view.elements) {
            if (elem && elem.data && elem.data.writeTo) {
              writeTo = elem.data.writeTo;
              break;
            }
          }
        }
        if (writeTo) {
          deepSet(card, writeTo, patch.fieldValues);
        } else {
          card.card_data = { ...(card.card_data || {}), ...patch.fieldValues };
        }
      } else if (Array.isArray(patch._stagedFiles) && patch._stagedFiles.length > 0) {
        return card;
      } else {
        for (const [key, value] of Object.entries(patch)) {
          if (key === '_stagedFiles') continue;
          if (
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            card[key] !== null &&
            typeof card[key] === 'object' &&
            !Array.isArray(card[key])
          ) {
            card[key] = { ...card[key], ...value };
          } else {
            card[key] = value;
          }
        }
      }

      return card;
    });
  }

  function clearChatRecords(cardId) {
    const { safeCardId } = ensureCardStorageDirs(cardId);
    const chatStore = chatArtifactsForCard(cardId);
    if (!chatStore) return;
    chatStore.clear(safeCardId);
  }

  function readCardStoredFileNames(cardId) {
    const names = [];
    try {
      const card = readCardFromStore(cardId);
      if (!card) return names;
      const metadata = cardFileMetadataStore().read(card && card.card_data ? card.card_data : null);
      for (const entry of metadata) names.push(entry.stored_name);
    } catch {
      // ignore malformed card file
    }
    return names;
  }

  function nextChatStoredName(cardId, role) {
    const { safeCardId } = ensureCardStorageDirs(cardId);
    const chatStore = chatArtifactsForCard(cardId);
    const serial = chatStore ? chatStore.nextSerial(safeCardId) : 1;
    const safeRole = String(role || 'system').toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'system';
    return `${String(serial).padStart(3, '0')}_${safeRole}.txt`;
  }

  function writeChatRecord(cardId, role, text, files) {
    const now = new Date().toISOString();
    const { safeCardId } = ensureCardStorageDirs(cardId);
    const stores = artifactsStores(cardId);
    const outName = nextChatStoredName(cardId, role || 'system');
    const artifactKey = `${safeCardId}/${outName}`;

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

    if (stores.chats) stores.chats.putText(artifactKey, `${lines.join('\n')}\n`);
    const serial = parseLeadingSerial(outName);
    const chatStore = chatArtifactsForCard(cardId);
    if (chatStore) {
      chatStore.appendIndexRecord(safeCardId, {
        serial,
        role: role || 'system',
        stored_name: outName,
        path: `${cardId}/chats/${outName}`,
        updated_at: now,
      });
    }
    return {
      at: now,
      role: role || 'system',
      text: msg,
      files: fileList,
      path: `${cardId}/chats/${outName}`,
    };
  }

  function readChatRecords(cardId) {
    const { safeCardId } = ensureCardStorageDirs(cardId);
    const chatStore = chatArtifactsForCard(cardId);
    if (!chatStore) return [];
    return chatStore.readRecords(safeCardId).map((row) => ({
      ...row,
      path: `${cardId}/chats/${row.stored_name}`,
    }));
  }

  function persistUploadedFile(cardId, requestedName, contentType, buffer) {
    const { safeCardId } = ensureCardStorageDirs(cardId);
    const stores = artifactsStores(cardId);
    const displayName = normalizeDisplayFileName(requestedName);
    const fileStore = fileArtifactsForCard(cardId);
    const storedName = fileStore
      ? fileStore.allocateStoredName(safeCardId, displayName, {
        seedNames: readCardStoredFileNames(cardId),
        maxLen: MAX_STORED_FILE_NAME_LEN,
      })
      : `${String(Date.now())}-${displayName}`;

    if (stores.files) {
      stores.files.putBytes(`${safeCardId}/${storedName}`, new Uint8Array(buffer), contentType || 'application/octet-stream');
    }

    return {
      name: displayName,
      stored_name: storedName,
      size: buffer.length,
      mime_type: contentType || 'application/octet-stream',
      path: `${cardId}/files/${storedName}`,
      uploaded_at: new Date().toISOString(),
    };
  }

  // Fire-and-forget invocation of .chat-handler after a user chat message is persisted.
  // The handler file lives in the appropriate runtime dir (.chat-handler).
  // Called with: --boardId <id> --cardId <id> --extraEncJson <base64json>
  // extraEncJson decodes to:
  //   boardSetupRoot      — absolute path to board root (parent of runtime/, surface/, runtime-out/)
  //   boardRuntimeDir     — relative: 'runtime' (or 'gandalf-runtime' for gandalf cards)
  //   runtimeStatusDir    — relative: 'runtime-out'
  //   cardsDir            — relative: 'surface/tmp-cards' (or 'surface/tmp-gandalf-cards')
  //   chatDir             — relative (from cardsDir): e.g. 'card-portfolio/chats'
  //   lastChatFile        — filename of the just-written user message, e.g. '001_user.txt'
  //   boardLiveCardsCliJs — absolute path to board-live-cards-cli.js (if configured)
  //   stepMachineCliPath  — absolute path to step-machine-cli.js (if configured)
  // Handler failures are logged and silently ignored — chat-send response is never affected.
  function invokeChatHandler(cardId, chatsDir, lastChatFile) {
    const isGandalf = isGandalfCard(cardId);
    const runtimeDir = isGandalf ? gandalfRuntimeDir : boardDir;
    const handlerFile = path.join(runtimeDir, '.chat-handler');
    if (!fs.existsSync(handlerFile)) return;
    const handlerCmd = fs.readFileSync(handlerFile, 'utf-8').trim();
    if (!handlerCmd) return;
    const boardSetupRoot = path.dirname(boardDir);
    const processingFile = path.join(chatsDir, '.processing');
    try { fs.mkdirSync(chatsDir, { recursive: true }); fs.writeFileSync(processingFile, '', 'utf-8'); } catch {}
    const extra = Buffer.from(JSON.stringify({
      boardSetupRoot,
      boardRuntimeDir:  path.relative(boardSetupRoot, isGandalf ? gandalfRuntimeDir : boardDir),
      runtimeStatusDir: path.relative(boardSetupRoot, isGandalf ? gandalfRuntimeOutDir : runtimeOutDir),
      cardsDir:         path.relative(boardSetupRoot, isGandalf ? tmpGandalfCardsDir : tmpCardsDir),
      chatDir:          chatsDir,
      lastChatFile,
      ...(serverUrl ? { serverUrl } : {}),
      ...(configuredBoardLiveCardsCliJs ? { boardLiveCardsCliJs: configuredBoardLiveCardsCliJs } : {}),
      ...(configuredStepMachineCliPath ? { stepMachineCliPath: configuredStepMachineCliPath } : {}),
    })).toString('base64');
    try {
      const proc = spawn(handlerCmd, [
        '--boardId', boardId, '--cardId', String(cardId),
        '--extraEncJson', extra,
        '--cleanOnExit', processingFile,
      ], {
        shell: true,
        stdio: 'ignore',
      });
      proc.unref();
      console.log(`[chat-handler] invoked for card "${cardId}" (boardId: "${boardId}")`);
    } catch (err) {
      try { fs.unlinkSync(processingFile); } catch {}
      console.warn(`[chat-handler] spawn failed for card "${cardId}":`, (err && err.message) || String(err));
    }
  }

  function applyCardAction(cardId, actionType, payload) {
    const persistCard = actionType === 'chat-send' ? updateCardLocalOnly : updateCard;
    let chatHandlerArgs = null;
    persistCard(cardId, (card) => {
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
                    stored_name: f.stored_name || null,
                  };
                }
                return null;
              })
              .filter(Boolean)
          : [];

        if (text || files.length > 0) {
          const { chatsDir } = ensureCardStorageDirs(cardId);
          const userRecord = writeChatRecord(cardId, 'user', text, files);
          chatHandlerArgs = { chatsDir, lastChatFile: path.basename(userRecord.path) };
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
        const files = cardFileMetadataStore().normalizeIncoming(payload && payload.files, now);

        if (files.length > 0) {
          cardFileMetadataStore().merge(cardData, files);
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

    if (chatHandlerArgs) {
      invokeChatHandler(cardId, chatHandlerArgs.chatsDir, chatHandlerArgs.lastChatFile);
    }
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
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

  function broadcastToSseClients() {
    const payload = buildPublishedRuntimePayload();
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(data);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function handleSse(req, res) {
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    sseClients.add(res);
    res.write(`data: ${JSON.stringify(buildPublishedRuntimePayload())}\n\n`);

    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
      res.end();
    });
  }

  async function handleDemoSetupApi(req, res, parsedUrl) {
    return false; // Demo-setup is handled by the host layer.
  }

  async function handleRuntimeApi(req, res, parsedUrl) {
    const method = req.method || 'GET';
    const url = parsedUrl || parseUrl(req.url || '/');
    const p = url.pathname;

    try {
      if (method === 'GET' && p === `${apiBasePath}/init-board`) {
        const taskExecutorPathParam = url.searchParams.get('taskExecutorPath') || '';
        const chatHandlerPathParam = url.searchParams.get('chatHandlerPath') || '';
        await initBoardAndSetup(taskExecutorPathParam, chatHandlerPathParam);
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/bootstrap-cards`) {
        await bootstrapBoard();
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/bootstrap`) {
        await bootstrapBoard();
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/sse`) {
        await bootstrapBoard();
        handleSse(req, res);
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/board-status`) {
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      const cardMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)$`));
      if (method === 'PATCH' && cardMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardMatch[1]);
        const body = await readJsonBody(req);
        patchCard(cardId, body);
        broadcastToSseClients();
        json(res, 200, { ok: true });
        return true;
      }

      const cardActionMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)/actions$`));
      if (method === 'POST' && cardActionMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardActionMatch[1]);
        const body = await readJsonBody(req);
        applyCardAction(cardId, body && body.actionType, body && body.payload);
        broadcastToSseClients();
        json(res, 200, { ok: true });
        return true;
      }

      const cardChatsMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)/chats$`));
      if (method === 'GET' && cardChatsMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsMatch[1]);
        json(res, 200, { ok: true, messages: readChatRecords(cardId) });
        return true;
      }

      const cardFileMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)/files$`));
      if (method === 'POST' && cardFileMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardFileMatch[1]);
        const inChat = String(url.searchParams.get('inChat') || '').toLowerCase() === 'true';
        const encodedName = req.headers['x-file-name'];
        const contentType = String(req.headers['content-type'] || 'application/octet-stream');
        const rawName = Array.isArray(encodedName) ? encodedName[0] : encodedName;
        const requestedName = rawName ? decodeURIComponent(String(rawName)) : 'upload.bin';
        const body = await readRawBody(req);
        if (!body.length) {
          json(res, 400, { error: 'Empty upload body' });
          return true;
        }

        const file = persistUploadedFile(cardId, requestedName, contentType, body);
        if (inChat) {
          updateCardLocalOnly(cardId, (card) => {
            const now = new Date().toISOString();
            const cardData = card.card_data && typeof card.card_data === 'object' ? card.card_data : {};
            card.card_data = cardData;
            const incoming = cardFileMetadataStore().normalizeIncoming([{
              name: file.name,
              stored_name: file.stored_name,
              size: file.size,
              mime_type: file.mime_type,
              path: file.path,
              uploaded_at: file.uploaded_at || now,
            }], now);
            cardFileMetadataStore().merge(cardData, incoming);
            return card;
          });
          writeChatRecord(cardId, 'system', `file uploaded: ${file.name} as ${file.stored_name}`, []);
        }
        broadcastToSseClients();
        json(res, 200, { ok: true, file });
        return true;
      }

      const cardFileDownloadMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)/files/(\\d+)$`));
      if (method === 'GET' && cardFileDownloadMatch) {
        const cardId = decodeURIComponent(cardFileDownloadMatch[1]);
        const idx = parseInt(cardFileDownloadMatch[2], 10);
        const expectedStoredName = url.searchParams.get('sn');

        const card = readCardFromStore(cardId);
        if (!card || typeof card !== 'object') {
          json(res, 404, { error: 'Card not found' });
          return true;
        }

        const resolved = cardFileMetadataStore().resolve(card.card_data, idx, expectedStoredName);
        if (!resolved.ok && resolved.reason === 'stale_reference') {
          json(res, 409, { error: 'File reference is stale. Refresh and try again.' });
          return true;
        }
        if (!resolved.ok) {
          json(res, 404, { error: 'File not found' });
          return true;
        }

        const fileRecord = resolved.file;

        const { safeCardId } = ensureCardStorageDirs(cardId);
        const stores = artifactsStores(cardId);
        const fileKey = `${safeCardId}/${fileRecord.stored_name}`;
        const bytes = stores.files ? stores.files.getBytes(fileKey) : null;
        if (!bytes) {
          json(res, 404, { error: 'File not found' });
          return true;
        }

        const buffer = Buffer.from(bytes);
        const filename = fileRecord.name || fileRecord.stored_name;
        const mimeType = fileRecord.mime_type || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': buffer.length,
        });
        res.end(buffer);
        return true;
      }

      return false;
    } catch (err) {
      const statusCode = err && err.statusCode ? err.statusCode : 500;
      json(res, statusCode, { error: String((err && err.message) || err) });
      return true;
    }
  }

  return {
    apiBasePath,
    corsHeaders,
    boardDir,
    tmpSurfaceDir,
    runtimeOutDir,
    parseUrl,
    json,
    runCli,
    cardsDir,
    gandalfCardsDir,
    buildPublishedRuntimePayload,
    handleRuntimeApi,
    clearChatRecords,
  };
}
