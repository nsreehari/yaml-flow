#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  createMultiBoardServerRuntime,
  createSingleBoardServerRuntime,
} from 'yaml-flow/server-runtime';

import {
  createFsBoardPlatformAdapter,
  createArtifactsStore,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const _require = createRequire(import.meta.url);

function resolveYamlFlowDir() {
  try {
    return path.dirname(_require.resolve('yaml-flow/package.json'));
  } catch {
    return null;
  }
}

const _yamlFlowDir = resolveYamlFlowDir();

// cliDir must point to the yaml-flow root so buildBoardCliInvocation finds
// board-live-cards-cli.js for task-executor completion callbacks.
// demo-src/example-board is 2 levels below the yaml-flow root.
const YAML_FLOW_CLI_DIR = _yamlFlowDir || path.resolve(__dirname, '..', '..');
const _pkgStepMachineCli = _yamlFlowDir ? path.join(_yamlFlowDir, 'step-machine-cli.js') : null;

function loadServerConfig() {
  const configPath = path.join(__dirname, 'demo-server-config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveFromConfig(configValue) {
  if (typeof configValue !== 'string' || !configValue.trim()) return null;
  return path.resolve(__dirname, configValue);
}

function resolveKindRefFromConfig(configValue) {
  if (typeof configValue !== 'string' || !configValue.trim()) return null;
  const trimmed = configValue.trim();
  if (!trimmed.startsWith('::fs-path::')) return trimmed;
  const rawPath = trimmed.slice('::fs-path::'.length).trim();
  if (!rawPath) return null;
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);
  return `::fs-path::${resolved}`;
}

const serverConfig = loadServerConfig();
const configuredCardsDir = resolveFromConfig(serverConfig.cardsDir);
const configuredTaskExecutorPath = resolveFromConfig(serverConfig.taskExecutorPath || serverConfig.demoTaskExecutorPath);
const configuredStepMachineCliPath = resolveFromConfig(serverConfig.stepMachineCliPath) || _pkgStepMachineCli;
const configuredChatHandlerPath = resolveFromConfig(serverConfig.chatHandlerPath);
const configuredInferenceAdapterPath = resolveFromConfig(serverConfig.inferenceAdapterPath);
const configuredGandalfCardsDir = resolveFromConfig(serverConfig.gandalfCardsDir);
const configuredGandalfTaskExecutorPath = resolveFromConfig(serverConfig.gandalfTaskExecutorPath);
const configuredGandalfChatHandlerPath = resolveFromConfig(serverConfig.gandalfChatHandlerPath);
const configuredGandalfInferenceAdapterPath = resolveFromConfig(serverConfig.gandalfInferenceAdapterPath);
const configuredServerMetaStoreRef = resolveKindRefFromConfig(serverConfig.serverMetaStoreRef);

if (!process.env.DEMO_STEP_MACHINE_CLI_PATH && configuredStepMachineCliPath) {
  process.env.DEMO_STEP_MACHINE_CLI_PATH = configuredStepMachineCliPath;
}
if (!process.env.DEMO_CHAT_HANDLER_PATH && configuredChatHandlerPath) {
  process.env.DEMO_CHAT_HANDLER_PATH = configuredChatHandlerPath;
}
if (!process.env.DEMO_INFERENCE_ADAPTER_PATH && configuredInferenceAdapterPath) {
  process.env.DEMO_INFERENCE_ADAPTER_PATH = configuredInferenceAdapterPath;
}

const PORT = Number(process.env.DEMO_SERVER_PORT || serverConfig.port || 7799);
const RESET_ON_START = process.argv.includes('--reset');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

// ---------------------------------------------------------------------------
// Setup directory & defaults
// ---------------------------------------------------------------------------

const setupDir = path.resolve(
  process.env.DEMO_SETUP_DIR || path.join(__dirname, '.demo-setup'),
);
fs.mkdirSync(setupDir, { recursive: true });

const defaultCardsDir = path.resolve(
  process.env.DEMO_CARDS_DIR || configuredCardsDir || path.join(__dirname, 'cards'),
);

const defaultTaskExecutorPath = process.env.DEMO_TASK_EXECUTOR_PATH || configuredTaskExecutorPath || null;
const defaultChatHandlerPath = process.env.DEMO_CHAT_HANDLER_PATH || configuredChatHandlerPath || null;
const defaultInferenceAdapterPath = process.env.DEMO_INFERENCE_ADAPTER_PATH || configuredInferenceAdapterPath || null;
const defaultStepMachineCliPath = process.env.DEMO_STEP_MACHINE_CLI_PATH || configuredStepMachineCliPath || null;
const defaultGandalfCardsDir = process.env.DEMO_GANDALF_CARDS_DIR || configuredGandalfCardsDir || null;
const defaultGandalfTaskExecutorPath = process.env.DEMO_GANDALF_TASK_EXECUTOR_PATH || configuredGandalfTaskExecutorPath || null;
const defaultGandalfChatHandlerPath = process.env.DEMO_GANDALF_CHAT_HANDLER_PATH || configuredGandalfChatHandlerPath || null;
const defaultGandalfInferenceAdapterPath = process.env.DEMO_GANDALF_INFERENCE_ADAPTER_PATH || configuredGandalfInferenceAdapterPath || null;

// ---------------------------------------------------------------------------
// Host adapter factories — Node-specific implementations injected into the
// platform-free server runtime.
// ---------------------------------------------------------------------------

function createFsCardSource(cardsDir) {
  return {
    listCards() {
      if (!fs.existsSync(cardsDir)) return [];
      return fs.readdirSync(cardsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf-8')); }
          catch { return null; }
        })
        .filter(Boolean);
    },
  };
}

function namedPipePath(pipeName) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${pipeName}`;
  return path.join(os.tmpdir(), `${pipeName}.sock`);
}

function makeExecutionRef(scriptPath, meta) {
  if (!scriptPath) return undefined;
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);
  return { howToRun: 'local-node', whatToRun: `::fs-path::${resolved}`, meta };
}

function createNodeSpawnInvocationAdapter() {
  return {
    async invoke(ref, args) {
      if (ref.howToRun !== 'local-node') {
        return { dispatched: false, error: `unsupported howToRun: ${ref.howToRun}` };
      }
      const whatToRun = String(ref.whatToRun || '');
      const scriptPath = whatToRun.startsWith('::fs-path::') ? whatToRun.slice('::fs-path::'.length) : '';
      if (!scriptPath) {
        return { dispatched: false, error: `no script path in whatToRun: ${whatToRun}` };
      }
      // Resolve chatsKeyPrefix (blob key prefix) to absolute FS chatDir for handlers
      const finalArgs = { ...args };
      if (finalArgs.chatsKeyPrefix && finalArgs.chatsBlobBasePath) {
        const cardPart = String(finalArgs.chatsKeyPrefix).split('/')[0];
        finalArgs.chatDir = path.join(String(finalArgs.chatsBlobBasePath), cardPart);
      }
      delete finalArgs.chatsKeyPrefix;
      delete finalArgs.chatsBlobBasePath;
      const extra = Buffer.from(JSON.stringify(finalArgs)).toString('base64');
      try {
        const proc = spawn(process.execPath, [
          scriptPath,
          '--boardId', String(args.boardId || ''),
          '--cardId', String(args.cardId || ''),
          '--extraEncJson', extra,
        ], { stdio: 'ignore', windowsHide: true });
        proc.unref();
        return { dispatched: true };
      } catch (err) {
        return { dispatched: false, error: err?.message || String(err) };
      }
    },
    async describe(ref) {
      if (ref.howToRun !== 'local-node') return null;
      const whatToRun = String(ref.whatToRun || '');
      const scriptPath = whatToRun.startsWith('::fs-path::') ? whatToRun.slice('::fs-path::'.length) : '';
      if (!scriptPath) return null;
      try {
        const result = spawnSync(process.execPath, [scriptPath, 'describe'], {
          timeout: 5000, encoding: 'utf-8', windowsHide: true,
        });
        if (result.status !== 0) return null;
        return JSON.parse(String(result.stdout).trim());
      } catch { return null; }
    },
  };
}

function createNamedPipeNotificationTransport() {
  return {
    async subscribe(ref, onEvent) {
      if (ref.kind !== 'named-pipe') {
        console.warn(`[notification] unsupported transport kind: ${ref.kind}`);
        return () => {};
      }
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

// ---------------------------------------------------------------------------
// Server meta store (multi-board registry)
// ---------------------------------------------------------------------------

const serverMetaRef = process.env.DEMO_SERVER_META_STORE_REF || configuredServerMetaStoreRef || `::fs-path::${setupDir}`;
const serverMetaAdapter = createFsBoardPlatformAdapter(
  parseRef(serverMetaRef), YAML_FLOW_CLI_DIR, { suppressSpawn: true },
);
const serverMetaStore = createArtifactsStore(serverMetaAdapter.blobStorage('server-meta'));

// ---------------------------------------------------------------------------
// Build multi-board runtime
// ---------------------------------------------------------------------------

const apiBasePath = '/api/boards';
const invocationAdapter = createNodeSpawnInvocationAdapter();
const notificationTransport = createNamedPipeNotificationTransport();
const logger = { info: console.log, warn: console.warn, error: console.error };

// Track per-board host config for demo-setup (FS paths are host concerns, not runtime concerns)
const boardHostConfig = new Map();

function buildBoardContextConfig(label, boardDir, cardsDir, taskExecPath, chatHandlerPath, infAdapterPath, boardId) {
  fs.mkdirSync(boardDir, { recursive: true });

  const notifyChannel = `yaml-flow-server-${label}-${boardId}-${process.pid}`;
  const baseRef = parseRef(`::fs-path::${boardDir}`);
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, YAML_FLOW_CLI_DIR, {
    notifyChannel,
  });
  // In the server context the drain loop is driven in-process; suppress the
  // detached CLI spawn that the FS adapter would otherwise fire as a continuation.
  boardAdapter.requestProcessAccumulated = () => {};
  // Separate artifacts adapter rooted at cardsDir (preserves old FS layout where
  // chats/files live under cardsDir rather than boardDir)
  const artifactsRef = parseRef(`::fs-path::${cardsDir}`);
  const artifactsAdapter = createFsBoardPlatformAdapter(artifactsRef, YAML_FLOW_CLI_DIR, { suppressSpawn: true });

  const cardStoreRef = serializeRef({ kind: 'fs-path', value: path.join(cardsDir, 'cards') });

  return {
    label,
    boardAdapter,
    artifactsAdapter,
    baseRef,
    cardStoreRef,
    outputsStoreRef: serializeRef({ kind: 'fs-path', value: path.join(path.dirname(boardDir), 'runtime-out', '.outputs') }),
    notifyRef: { kind: 'named-pipe', value: namedPipePath(notifyChannel) },
    taskExecutorRef: makeExecutionRef(taskExecPath, 'task-executor'),
    chatHandlerRef: makeExecutionRef(chatHandlerPath, 'chat-handler'),
    inferenceAdapterRef: makeExecutionRef(infAdapterPath, 'inference-adapter'),
  };
}

const runtime = createMultiBoardServerRuntime({
  apiBasePath,
  serverMetaStore,
  logger,
  boardRuntimeFactory: (boardId, entry) => {
    const cardsDir = typeof entry.cardsDir === 'string' ? path.resolve(entry.cardsDir) : defaultCardsDir;
    const boardRoot = path.join(setupDir, `board-${boardId}`);
    const boardDir = path.join(boardRoot, 'runtime');

    const taskExecPath = typeof entry.taskExecutorPath === 'string' ? entry.taskExecutorPath : defaultTaskExecutorPath;
    const chatHandlerPath_ = typeof entry.chatHandlerPath === 'string' ? entry.chatHandlerPath : defaultChatHandlerPath;
    const infAdapterPath = typeof entry.inferenceAdapterPath === 'string' ? entry.inferenceAdapterPath : defaultInferenceAdapterPath;
    const stepMachinePath = typeof entry.stepMachineCliPath === 'string' ? entry.stepMachineCliPath : defaultStepMachineCliPath;

    const gandalfCardsDir_ = typeof entry.gandalfCardsDir === 'string' ? path.resolve(entry.gandalfCardsDir) : defaultGandalfCardsDir;
    const gandalfTaskExecPath = typeof entry.gandalfTaskExecutorPath === 'string' ? entry.gandalfTaskExecutorPath : defaultGandalfTaskExecutorPath;
    const gandalfChatPath = typeof entry.gandalfChatHandlerPath === 'string' ? entry.gandalfChatHandlerPath : defaultGandalfChatHandlerPath;
    const gandalfInfPath = typeof entry.gandalfInferenceAdapterPath === 'string' ? entry.gandalfInferenceAdapterPath : defaultGandalfInferenceAdapterPath;

    const baseCfg = buildBoardContextConfig('base', boardDir, cardsDir, taskExecPath, chatHandlerPath_, infAdapterPath, boardId);

    const boards = [baseCfg];
    if (gandalfCardsDir_ && gandalfTaskExecPath) {
      const gandalfBoardDir = path.join(boardRoot, 'gandalf-runtime');
      const gandalfCfg = buildBoardContextConfig('gandalf', gandalfBoardDir, gandalfCardsDir_, gandalfTaskExecPath, gandalfChatPath, gandalfInfPath, boardId);
      // Fix gandalf outputsStoreRef
      gandalfCfg.outputsStoreRef = serializeRef({ kind: 'fs-path', value: path.join(boardRoot, 'gandalf-runtime-out', '.outputs') });
      boards.push(gandalfCfg);
    }

    // Store host config for demo-setup (FS paths are host concerns)
    boardHostConfig.set(boardId, { cardsDir, gandalfCardsDir: gandalfCardsDir_, boardDir, boardRoot });

    // Auto-run demo-setup (write copilot-instructions.md) at board init time,
    // so clients no longer need a separate /demo-setup request before bootstrapping.
    demoPrepSetup(boardId);

    const singleBoardRuntime = createSingleBoardServerRuntime({
      apiBasePath: `${apiBasePath}/${boardId}`,
      boardId,
      boards,
      invocationAdapter,
      notificationTransport,
      logger,
      serverUrl: `http://127.0.0.1:${PORT}`,
      executionExtra: {
        boardSetupRoot: boardRoot,
        chatsBlobBasePath: path.join(cardsDir, 'chats'),
        ...(stepMachinePath ? { stepMachineCliPath: stepMachinePath } : {}),
      },
    });

    // Host concern (Part A): seed card store from FS source only if empty
    const existing = singleBoardRuntime.cardStore.get({});
    const isEmpty = existing.status !== 'success' || !existing.data?.cards?.length;
    if (isEmpty) {
      const cards = createFsCardSource(cardsDir).listCards();
      if (cards.length) singleBoardRuntime.cardStore.set({ body: cards });
    }

    return singleBoardRuntime;
  },
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

function resetRuntime() {
  if (fs.existsSync(setupDir)) {
    fs.rmSync(setupDir, { recursive: true, force: true });
    console.log(`[demo-server] reset: wiped ${setupDir}`);
  }
  const chatSessionsDir = serverConfig.chatSessionsDir
    ? path.resolve(__dirname, serverConfig.chatSessionsDir)
    : path.join(os.tmpdir(), 'demo-chat-handler-sessions');
  if (fs.existsSync(chatSessionsDir)) {
    fs.rmSync(chatSessionsDir, { recursive: true, force: true });
    console.log(`[demo-server] reset: wiped ${chatSessionsDir}`);
  }
}

if (RESET_ON_START) {
  resetRuntime();
}

// ---------------------------------------------------------------------------
// Demo-setup — host-level concern (not a runtime concern).
// Writes concatenated copilot-instructions.md at the board setup root.
// ---------------------------------------------------------------------------

const BOARD_SEG_RE = /^\/api\/boards\/([^/]+)\/(.+)$/;
const _demoPrepSetupDone = new Map();

function isDemoSetupDone(boardId) {
  const cfg = boardHostConfig.get(boardId);
  return _demoPrepSetupDone.get(boardId) === true && cfg && fs.existsSync(cfg.cardsDir);
}

function demoPrepSetup(boardId) {
  const cfg = boardHostConfig.get(boardId);
  if (!cfg) return;
  const { cardsDir, gandalfCardsDir, boardDir } = cfg;

  const boardSetupRoot = path.dirname(boardDir);
  fs.mkdirSync(boardSetupRoot, { recursive: true });
  const srcDir = path.dirname(cardsDir);
  const agentInstructionFiles = ['agent-instructions.md', 'agent-instructions-cardlayout.md'];
  const parts = [];
  for (const fname of agentInstructionFiles) {
    const fpath = path.join(srcDir, fname);
    if (fs.existsSync(fpath)) parts.push(fs.readFileSync(fpath, 'utf-8').trimEnd());
  }
  if (parts.length > 0) {
    fs.writeFileSync(path.join(boardSetupRoot, 'copilot-instructions.md'), parts.join('\n\n') + '\n', 'utf-8');
  }

  _demoPrepSetupDone.set(boardId, true);
}

function jsonReply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleDemoSetup(req, res, boardId) {
  try {
    // requireBoardService triggers the factory which runs demoPrepSetup automatically.
    // This endpoint is kept for backward compatibility but setup is now done at board
    // init time inside boardRuntimeFactory — no extra work needed here.
    runtime.requireBoardService(boardId);
    jsonReply(res, 200, { ok: true, setupPerformed: false });
  } catch (err) {
    jsonReply(res, err.statusCode || 500, { error: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// WorkIQ proxy — host-level concern
// ---------------------------------------------------------------------------

async function handleWorkiqAsk(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let query;
  try {
    query = JSON.parse(body).query;
  } catch {
    return jsonReply(res, 400, { error: 'Invalid JSON body' });
  }
  if (!query || typeof query !== 'string') {
    return jsonReply(res, 400, { error: '{ query } string is required' });
  }

  const workiqJs = path.join(
    process.env.APPDATA || os.homedir(),
    'npm', 'node_modules', '@microsoft', 'workiq', 'bin', 'workiq.js'
  );
  if (!fs.existsSync(workiqJs)) {
    return jsonReply(res, 503, { error: `WorkIQ CLI not found at: ${workiqJs}` });
  }

  await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let responded = false;
    const child = spawn(process.execPath, [workiqJs, 'ask', '-q', query], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', (err) => {
      if (!responded) {
        responded = true;
        clearTimeout(timeoutId);
        jsonReply(res, 500, { error: `workiq spawn error: ${err.message}` });
      }
      resolve();
    });
    child.on('close', (code) => {
      if (!responded) {
        responded = true;
        clearTimeout(timeoutId);
        if (code !== 0) {
          jsonReply(res, 500, { error: `workiq exited ${code}`, stderr });
        } else {
          jsonReply(res, 200, { response: stdout });
        }
      }
      resolve();
    });
    const timeoutId = setTimeout(() => {
      if (!responded) {
        responded = true;
        child.kill();
        jsonReply(res, 504, { error: 'workiq timed out after 60s' });
      }
      resolve();
    }, 60_000);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Route: POST /api/workiq/ask — proxy to WorkIQ (M365 Copilot) from server TTY
  if (method === 'POST' && pathname === '/api/workiq/ask') {
    void handleWorkiqAsk(req, res);
    return;
  }

  // Route: demo-setup is handled here in demo-server (host concern)
  const boardSegMatch = pathname.match(BOARD_SEG_RE);
  if (boardSegMatch && boardSegMatch[2] === 'demo-setup') {
    void handleDemoSetup(req, res, boardSegMatch[1]);
    return;
  }

  // All other /api/boards routes are handled by the platform-free runtime
  runtime.handleApi(req, res, url).then((handled) => {
    if (!handled) {
      jsonReply(res, 404, { error: 'Not found' });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[demo-server] setup dir: ${setupDir}`);
  console.log(`[demo-server] server-meta store: ${serverMetaRef}`);
  console.log('[demo-server] endpoints:');
  console.log(`  GET  ${apiBasePath}                          <- list boards`);
  console.log(`  POST ${apiBasePath}  {id, label?}            <- register board`);
  console.log(`  GET  ${apiBasePath}/:boardId/demo-setup  (no-op; setup now runs at board init)`);
  console.log(`  GET  ${apiBasePath}/:boardId/init-board`);
  console.log(`  GET  ${apiBasePath}/:boardId/sse`);
  console.log(`  GET  ${apiBasePath}/:boardId/board-status`);
  console.log(`  PATCH ${apiBasePath}/:boardId/cards/:id`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/actions`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/files`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id/files/:idx`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id/chats`);
  console.log(`  POST /api/workiq/ask  {query}              <- WorkIQ (M365 Copilot) proxy`);
});
