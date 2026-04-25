import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';

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
 *     boards-config.json          ← board registry
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

  const boardsConfigFile = path.join(setupDir, 'boards-config.json');
  const boardServiceCache = new Map();

  fs.mkdirSync(setupDir, { recursive: true });

  function readBoardsConfig() {
    if (!fs.existsSync(boardsConfigFile)) {
      return { boards: [{ id: 'default', label: 'Default Board' }] };
    }
    try {
      return JSON.parse(fs.readFileSync(boardsConfigFile, 'utf-8'));
    } catch {
      return { boards: [{ id: 'default', label: 'Default Board' }] };
    }
  }

  function writeBoardsConfig(config) {
    fs.writeFileSync(boardsConfigFile, JSON.stringify(config, null, 2));
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
      boardLiveCardsCliJs: options.boardLiveCardsCliJs,
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
  const tmpCardsDir = path.join(tmpSurfaceDir, 'tmp-cards');
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

  const statusSnapshotFile = path.join(runtimeOutDir, 'board-livegraph-status.json');
  const boardFile = path.join(boardDir, 'board-graph.json');
  const inventoryFile = path.join(boardDir, 'cards-inventory.jsonl');

  let didDemoSetup = false;

  function resolveCliJsPath() {
    if (configuredBoardLiveCardsCliJs && fs.existsSync(configuredBoardLiveCardsCliJs)) return configuredBoardLiveCardsCliJs;

    const envOverride = process.env.BOARD_LIVE_CARDS_CLI_JS;
    if (envOverride && fs.existsSync(envOverride)) return envOverride;

    const repoDevPath = path.join(path.resolve(__dirname, '../..'), 'dist', 'cli', 'board-live-cards-cli.js');
    if (fs.existsSync(repoDevPath)) return repoDevPath;

    try {
      const pkgJsonPath = require.resolve('yaml-flow/package.json', { paths: [process.cwd(), __dirname] });
      const pkgRoot = path.dirname(pkgJsonPath);
      const pkgCli = path.join(pkgRoot, 'board-live-cards-cli.js');
      if (fs.existsSync(pkgCli)) return pkgCli;

      const pkgDistCli = path.join(pkgRoot, 'dist', 'cli', 'board-live-cards-cli.js');
      if (fs.existsSync(pkgDistCli)) return pkgDistCli;
    } catch {
      // fall through
    }

    return null;
  }

  const cliJs = resolveCliJsPath();

  if (!process.env.DEMO_STEP_MACHINE_CLI_PATH && configuredStepMachineCliPath && fs.existsSync(configuredStepMachineCliPath)) {
    process.env.DEMO_STEP_MACHINE_CLI_PATH = configuredStepMachineCliPath;
  }

  function ensureCardStorageDirs(cardId) {
    const safeCardId = String(cardId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown-card';
    const cardDir = path.join(tmpCardsDir, safeCardId);
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
    const m = String(fileName || '').match(/^(\d+)[-_]/);
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

  function shellQuote(s) {
    return '"' + String(s).replace(/"/g, '\\"') + '"';
  }

  function ensureBuilt() {
    if (!cliJs || !fs.existsSync(cliJs)) {
      throw new Error(
        'Unable to locate board-live-cards CLI. Set boardLiveCardsCliJs option, BOARD_LIVE_CARDS_CLI_JS, or install yaml-flow in this project.'
      );
    }
  }

  function runCli(args) {
    ensureBuilt();
    return execFileSync(process.execPath, [cliJs, ...args], {
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
    if (!fs.existsSync(inventoryFile)) return [];
    return fs
      .readFileSync(inventoryFile, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  function readStatusSnapshot() {
    if (!fs.existsSync(statusSnapshotFile)) return null;
    return readJson(statusSnapshotFile);
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
    const cardsOutDir = path.join(runtimeOutDir, 'cards');
    if (!fs.existsSync(cardsOutDir)) return {};

    const out = {};
    for (const entry of fs.readdirSync(cardsOutDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.computed.json')) continue;
      const cardId = entry.name.slice(0, -'.computed.json'.length);
      out[cardId] = readJson(path.join(cardsOutDir, entry.name));
    }
    return out;
  }

  function readSourcePayloads(cardDefinition) {
    const out = {};
    if (!cardDefinition || !Array.isArray(cardDefinition.sources)) return out;

    for (const sourceDef of cardDefinition.sources) {
      if (!sourceDef || !sourceDef.bindTo || !sourceDef.outputFile) continue;
      const filePath = path.join(boardDir, cardDefinition.id, sourceDef.outputFile);
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
    const dirPath = path.join(runtimeOutDir, 'data-objects');
    if (!fs.existsSync(dirPath)) return {};

    const out = {};
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const token = entry.name;
      const filePath = path.join(dirPath, entry.name);
      try {
        out[token] = readJson(filePath);
      } catch {
        // Ignore malformed token files and continue.
      }
    }

    return out;
  }

  function readChatSignal(cardId) {
    const chatsDir = path.join(tmpCardsDir, cardId, 'chats');
    if (!fs.existsSync(chatsDir)) {
      return { count: 0, latest_mtime_ms: 0, processing: false };
    }

    let count = 0;
    let latestMtimeMs = 0;
    let processing = false;
    for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name === '.processing') { processing = true; continue; }
      count += 1;
      try {
        const st = fs.statSync(path.join(chatsDir, entry.name));
        const mtimeMs = Number(st.mtimeMs || 0);
        if (mtimeMs > latestMtimeMs) latestMtimeMs = mtimeMs;
      } catch {
        // Ignore transient file stat/read errors.
      }
    }

    return { count, latest_mtime_ms: latestMtimeMs, processing };
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

  function demoPrepSetup() {
    fs.mkdirSync(tmpSurfaceDir, { recursive: true });
    fs.rmSync(tmpCardsDir, { recursive: true, force: true });
    fs.mkdirSync(tmpCardsDir, { recursive: true });

    const entries = fs.readdirSync(cardsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.json')) continue;
      const src = path.join(cardsDir, entry.name);
      const dst = path.join(tmpCardsDir, entry.name);
      fs.copyFileSync(src, dst);
    }

    // Concatenate agent-instructions*.md files into copilot-instructions.md at boardSetupRoot
    const boardSetupRoot = path.dirname(boardDir);
    const agentInstructionFiles = ['agent-instructions.md', 'agent-instructions-cardlayout.md'];
    const srcDir = path.dirname(cardsDir); // board source dir where agent-instructions*.md live
    const parts = [];
    for (const fname of agentInstructionFiles) {
      const fpath = path.join(srcDir, fname);
      if (fs.existsSync(fpath)) {
        parts.push(fs.readFileSync(fpath, 'utf-8').trimEnd());
      }
    }
    if (parts.length > 0) {
      fs.writeFileSync(path.join(boardSetupRoot, 'copilot-instructions.md'), parts.join('\n\n') + '\n', 'utf-8');
    }

    didDemoSetup = true;
  }

  function ensureDemoSetup() {
    if (didDemoSetup && fs.existsSync(tmpCardsDir)) return;
    demoPrepSetup();
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

  function initBoard(taskExecutorPathParam, chatHandlerPathParam, inferenceAdapterPathParam) {
    fs.mkdirSync(boardDir, { recursive: true });

    const taskExecutorPath = resolveTaskExecutorPath(taskExecutorPathParam);
    const chatHandlerPath = resolveChatHandlerPath(chatHandlerPathParam);
    const inferenceAdapterPath = resolveInferenceAdapterPath(inferenceAdapterPathParam);
    const taskExecutorCmd = `${shellQuote(process.execPath)} ${shellQuote(taskExecutorPath)}`;
    const chatHandlerCmd = chatHandlerPath
      ? `${shellQuote(process.execPath)} ${shellQuote(chatHandlerPath)}`
      : null;
    const inferenceAdapterCmd = inferenceAdapterPath
      ? `${shellQuote(process.execPath)} ${shellQuote(inferenceAdapterPath)}`
      : null;

    const initArgs = ['init', boardDir, '--task-executor', taskExecutorCmd];
    if (chatHandlerCmd) initArgs.push('--chat-handler', chatHandlerCmd);
    if (inferenceAdapterCmd) initArgs.push('--inference-adapter', inferenceAdapterCmd);
    initArgs.push('--runtime-out', runtimeOutDir);

    try {
      runCli(initArgs);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!msg.includes('no valid board-graph.json')) throw err;

      clearDirContents(boardDir);
      fs.mkdirSync(boardDir, { recursive: true });
      runCli(initArgs);
    }
  }

  function initBoardAndSetup(taskExecutorPathParam, chatHandlerPathParam, inferenceAdapterPathParam) {
    ensureDemoSetup();

    if (!fs.existsSync(boardFile)) {
      initBoard(taskExecutorPathParam, chatHandlerPathParam, inferenceAdapterPathParam);
    }

    const expectedCardsRoot = path.resolve(tmpCardsDir);
    const hasStaleMapping = readInventory().some((entry) => {
      if (!entry || !entry.cardFilePath) return false;
      const mapped = path.resolve(entry.cardFilePath);
      return !mapped.startsWith(expectedCardsRoot + path.sep) && mapped !== expectedCardsRoot;
    });

    if (hasStaleMapping) {
      clearDirContents(boardDir);
      initBoard(taskExecutorPathParam, chatHandlerPathParam, inferenceAdapterPathParam);
    }
  }

  function bootstrapCards() {
    ensureDemoSetup();
    runCli(['upsert-card', '--rg', boardDir, '--card-glob', path.join(tmpCardsDir, '*.json')]);
  }

  function bootstrapBoard() {
    initBoardAndSetup();
    bootstrapCards();
  }

  function findCardPath(cardId) {
    const inv = readInventory();
    const found = inv.find((e) => e.cardId === cardId);
    return found ? found.cardFilePath : null;
  }

  function mutateCard(cardId, updateFn, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const syncBoard = options.syncBoard !== false;
    const cardPath = findCardPath(cardId);
    if (!cardPath || !fs.existsSync(cardPath)) {
      const err = new Error(`Card not found: ${cardId}`);
      err.statusCode = 404;
      throw err;
    }

    const card = readJson(cardPath);
    const nextCard = updateFn(card) || card;
    fs.writeFileSync(cardPath, JSON.stringify(nextCard, null, 2));

    if (syncBoard) {
      runCli(['upsert-card', '--rg', boardDir, '--card', cardPath, '--restart']);
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
    const { chatsDir } = ensureCardStorageDirs(cardId);
    clearDirContents(chatsDir);
  }

  function nextFileSerial(cardId) {
    const names = [];

    try {
      const cardPath = findCardPath(cardId);
      if (cardPath && fs.existsSync(cardPath)) {
        const card = readJson(cardPath);
        const files = card && card.card_data && Array.isArray(card.card_data.files) ? card.card_data.files : [];
        for (const entry of files) {
          if (entry && typeof entry.stored_name === 'string') names.push(entry.stored_name);
        }
      }
    } catch {
      // ignore malformed card file and fall back to dir scan
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
    return `${String(serial).padStart(3, '0')}_${safeRole}.txt`;
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

  function readChatRecords(cardId) {
    const { chatsDir } = ensureCardStorageDirs(cardId);
    if (!fs.existsSync(chatsDir)) return [];

    const out = [];
    for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const parsed = String(name).match(/^(\d+)[-_]([a-z0-9_-]+)\.txt$/i);
      const serial = parsed ? parseInt(parsed[1], 10) : 0;
      const role = parsed ? parsed[2].toLowerCase() : 'system';
      const filePath = path.join(chatsDir, name);
      const text = fs.readFileSync(filePath, 'utf-8');
      const stat = fs.statSync(filePath);
      out.push({
        serial,
        role,
        text,
        path: `${cardId}/chats/${name}`,
        stored_name: name,
        updated_at: new Date(stat.mtimeMs).toISOString(),
      });
    }

    out.sort((a, b) => a.serial - b.serial || a.stored_name.localeCompare(b.stored_name));
    return out;
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

  // Fire-and-forget invocation of .chat-handler after a user chat message is persisted.
  // boardDir/.chat-handler must contain the handler command as a single-line string.
  // Called with: --boardId <id> --cardId <id> --extraEncJson <base64json>
  // extraEncJson decodes to:
  //   boardSetupRoot  — absolute path to board root (parent of runtime/, surface/, runtime-out/)
  //   boardRuntimeDir — relative: 'runtime'
  //   runtimeStatusDir— relative: 'runtime-out'
  //   cardsDir        — relative: 'surface/tmp-cards'
  //   chatDir         — relative (from cardsDir): e.g. 'card-portfolio/chats'
  //   lastChatFile    — filename of the just-written user message, e.g. '001_user.txt'
  // Handler failures are logged and silently ignored — chat-send response is never affected.
  function invokeChatHandler(cardId, chatsDir, lastChatFile) {
    const handlerFile = path.join(boardDir, '.chat-handler');
    if (!fs.existsSync(handlerFile)) return;
    const handlerCmd = fs.readFileSync(handlerFile, 'utf-8').trim();
    if (!handlerCmd) return;
    const boardSetupRoot = path.dirname(boardDir);
    const processingFile = path.join(chatsDir, '.processing');
    try { fs.mkdirSync(chatsDir, { recursive: true }); fs.writeFileSync(processingFile, '', 'utf-8'); } catch {}
    const extra = Buffer.from(JSON.stringify({
      boardSetupRoot,
      boardRuntimeDir:  path.relative(boardSetupRoot, boardDir),
      runtimeStatusDir: path.relative(boardSetupRoot, runtimeOutDir),
      cardsDir:         path.relative(boardSetupRoot, tmpCardsDir),
      chatDir:          path.relative(tmpCardsDir, chatsDir),
      lastChatFile,
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
          const known = new Set(existing.map((f) => (f && f.stored_name ? f.stored_name : '')));
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

  function handleSse(req, res) {
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const stablePayloadString = (payload) =>
      JSON.stringify(payload, (key, value) => {
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
        runCli(['process-accumulated-events', '--rg', boardDir]);

        const nextPayload = buildPublishedRuntimePayload();
        const nextHash = stablePayloadString(nextPayload);
        if (nextHash !== lastPublishedHash) {
          lastPublishedHash = nextHash;
          emitCards(nextPayload);
        } else {
          res.write(': keepalive\n\n');
        }
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: String((err && err.message) || err) })}\n\n`);
      }
    }, 800);

    req.on('close', () => {
      clearInterval(poll);
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
        initBoardAndSetup(taskExecutorPathParam, chatHandlerPathParam);
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/bootstrap-cards`) {
        bootstrapCards();
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/bootstrap`) {
        bootstrapBoard();
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/sse`) {
        bootstrapBoard();
        handleSse(req, res);
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/board-status`) {
        ensureDemoSetup();
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      const cardMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)$`));
      if (method === 'PATCH' && cardMatch) {
        bootstrapBoard();
        const cardId = decodeURIComponent(cardMatch[1]);
        const body = await readJsonBody(req);
        patchCard(cardId, body);
        json(res, 200, { ok: true });
        return true;
      }

      const cardActionMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)/actions$`));
      if (method === 'POST' && cardActionMatch) {
        bootstrapBoard();
        const cardId = decodeURIComponent(cardActionMatch[1]);
        const body = await readJsonBody(req);
        applyCardAction(cardId, body && body.actionType, body && body.payload);
        json(res, 200, { ok: true });
        return true;
      }

      const cardChatsMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)/chats$`));
      if (method === 'GET' && cardChatsMatch) {
        bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsMatch[1]);
        json(res, 200, { ok: true, messages: readChatRecords(cardId) });
        return true;
      }

      const cardFileMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)/files$`));
      if (method === 'POST' && cardFileMatch) {
        bootstrapBoard();
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
            const existing = Array.isArray(cardData.files) ? cardData.files.slice() : [];
            const known = new Set(existing.map((f) => (f && f.stored_name ? f.stored_name : '')));
            if (!known.has(file.stored_name)) {
              existing.push({
                name: typeof file.name === 'string' ? file.name : file.stored_name,
                stored_name: file.stored_name,
                size: file.size || null,
                mime_type: file.mime_type || null,
                path: file.path || null,
                uploaded_at: file.uploaded_at || now,
              });
              cardData.files = existing;
            }
            return card;
          });
          writeChatRecord(cardId, 'system', `file uploaded: ${file.name} as ${file.stored_name}`, []);
        }
        json(res, 200, { ok: true, file });
        return true;
      }

      const cardFileDownloadMatch = p.match(new RegExp(`^${apiBasePath}/cards/([^/]+)/files/(\\d+)$`));
      if (method === 'GET' && cardFileDownloadMatch) {
        const cardId = decodeURIComponent(cardFileDownloadMatch[1]);
        const idx = parseInt(cardFileDownloadMatch[2], 10);
        const expectedStoredName = url.searchParams.get('sn');

        const cardPath = path.join(tmpCardsDir, `${cardId}.json`);
        if (!fs.existsSync(cardPath)) {
          json(res, 404, { error: 'Card not found' });
          return true;
        }

        let card;
        try {
          card = readJson(cardPath);
        } catch {
          json(res, 404, { error: 'Card not found' });
          return true;
        }

        const files = card.card_data && Array.isArray(card.card_data.files) ? card.card_data.files : [];
        if (idx < 0 || idx >= files.length) {
          json(res, 404, { error: 'File not found' });
          return true;
        }

        const fileRecord = files[idx];
        if (!fileRecord || !fileRecord.stored_name) {
          json(res, 404, { error: 'File not found' });
          return true;
        }
        if (expectedStoredName && expectedStoredName !== fileRecord.stored_name) {
          json(res, 409, { error: 'File reference is stale. Refresh and try again.' });
          return true;
        }

        const { filesDir } = ensureCardStorageDirs(cardId);
        const filePath = path.join(filesDir, fileRecord.stored_name);

        const realPath = path.resolve(filePath);
        const realFilesDir = path.resolve(filesDir);
        if (!realPath.startsWith(realFilesDir)) {
          json(res, 403, { error: 'Forbidden' });
          return true;
        }

        if (!fs.existsSync(filePath)) {
          json(res, 404, { error: 'File not found' });
          return true;
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
    tmpCardsDir,
    runtimeOutDir,
    parseUrl,
    json,
    runCli,
    demoPrepSetup,
    ensureDemoSetup,
    buildPublishedRuntimePayload,
    handleRuntimeApi,
    clearChatRecords,
  };
}
