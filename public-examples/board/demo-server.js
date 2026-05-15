#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createMultiBoardServerRuntime,
  createSingleBoardServerRuntime,
} from 'yaml-flow/board-live-cards-server-runtime';

import {
  createFsBoardPlatformAdapter,
  createArtifactsStore,
  invokeRefSync,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';
import {
  createStepMachineChatFlowRunner,
} from 'yaml-flow/step-machine-public';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliArgs = process.argv.slice(2);

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

function loadJsonFromConfig(configValue) {
  const resolved = resolveFromConfig(configValue);
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch {
    return null;
  }
}

function buildChatHandlerFlowFromScript(scriptPath) {
  if (!scriptPath) return null;
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(__dirname, scriptPath);
  return {
    id: 'demo-chat-script-handler',
    settings: { start_step: 'respond', max_total_steps: 5, timeout_ms: 120000 },
    steps: {
      respond: {
        description: 'Run the example board chat responder from a script path',
        handler: {
          type: 'ref',
          howToRun: 'local-node',
          whatToRun: { kind: 'fs-path', value: resolved },
        },
        transitions: { success: 'completed', failure: 'failed' },
      },
    },
    terminal_states: {
      completed: { description: 'Chat response completed', return_intent: 'success', return_artifacts: false },
      failed: { description: 'Chat response failed', return_intent: 'failure', return_artifacts: false },
    },
  };
}

function resolveKindRefFromConfig(configValue) {
  if (typeof configValue !== 'string' || !configValue.trim()) return null;
  const trimmed = configValue.trim();
  if (!trimmed.startsWith('b64:')) return trimmed;
  try {
    const parsed = parseRef(trimmed);
    if (parsed.kind !== 'fs-path') return trimmed;
    const rawPath = parsed.value.trim();
    if (!rawPath) return null;
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);
    return serializeRef({ kind: 'fs-path', value: resolved });
  } catch {
    return trimmed;
  }
}

const serverConfig = loadServerConfig();
const configuredCardsDir = resolveFromConfig(serverConfig.cardsDir);
const configuredTaskExecutorPath = resolveFromConfig(serverConfig.taskExecutorPath || serverConfig.demoTaskExecutorPath);
const configuredStepMachineCliPath = resolveFromConfig(serverConfig.stepMachineCliPath);
const configuredChatHandlerPath = resolveFromConfig(serverConfig.chatHandlerPath);
const configuredChatHandlerFlow = loadJsonFromConfig(serverConfig.chatHandlerFlowPath) || buildChatHandlerFlowFromScript(configuredChatHandlerPath);
const configuredInferenceAdapterPath = resolveFromConfig(serverConfig.inferenceAdapterPath);
const configuredGandalfCardsDir = resolveFromConfig(serverConfig.gandalfCardsDir);
const configuredGandalfTaskExecutorPath = resolveFromConfig(serverConfig.gandalfTaskExecutorPath);
const configuredGandalfChatHandlerPath = resolveFromConfig(serverConfig.gandalfChatHandlerPath);
const configuredGandalfChatHandlerFlow = loadJsonFromConfig(serverConfig.gandalfChatHandlerFlowPath) || buildChatHandlerFlowFromScript(configuredGandalfChatHandlerPath);
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
const cardsPatternArgIndex = cliArgs.indexOf('--cards-pattern');
const cliCardsPattern = cardsPatternArgIndex !== -1 ? cliArgs[cardsPatternArgIndex + 1] : null;
const selectedCardsPattern = (process.env.DEMO_CARDS_PATTERN || cliCardsPattern || '').trim() || null;

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
const defaultChatHandlerFlow = configuredChatHandlerFlow || buildChatHandlerFlowFromScript(process.env.DEMO_CHAT_HANDLER_PATH || configuredChatHandlerPath || null);
const defaultInferenceAdapterPath = process.env.DEMO_INFERENCE_ADAPTER_PATH || configuredInferenceAdapterPath || null;
const defaultStepMachineCliPath = process.env.DEMO_STEP_MACHINE_CLI_PATH || configuredStepMachineCliPath || null;
const defaultGandalfCardsDir = process.env.DEMO_GANDALF_CARDS_DIR || configuredGandalfCardsDir || null;
const defaultGandalfTaskExecutorPath = process.env.DEMO_GANDALF_TASK_EXECUTOR_PATH || configuredGandalfTaskExecutorPath || null;
const defaultGandalfChatHandlerFlow = configuredGandalfChatHandlerFlow || buildChatHandlerFlowFromScript(process.env.DEMO_GANDALF_CHAT_HANDLER_PATH || configuredGandalfChatHandlerPath || null);
const defaultGandalfInferenceAdapterPath = process.env.DEMO_GANDALF_INFERENCE_ADAPTER_PATH || configuredGandalfInferenceAdapterPath || null;

// ---------------------------------------------------------------------------
// Host adapter factories — Node-specific implementations injected into the
// platform-free server runtime.
// ---------------------------------------------------------------------------

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function createFsCardSource(cardsDir, cardPattern = null) {
  const cardRegex = cardPattern ? wildcardToRegExp(cardPattern) : null;
  return {
    listCards() {
      if (!fs.existsSync(cardsDir)) return [];
      return fs.readdirSync(cardsDir)
        .filter(f => {
          if (!f.endsWith('.json')) return false;
          if (!cardRegex) return true;
          const cardId = path.basename(f, '.json');
          return cardRegex.test(cardId);
        })
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
  return { howToRun: 'local-node', whatToRun: serializeRef({ kind: 'fs-path', value: resolved }), meta };
}

function createNodeSpawnInvocationAdapter() {
  return {
    async invoke(ref, args) {
      if (ref.howToRun !== 'local-node') {
        return { dispatched: false, error: `unsupported howToRun: ${ref.howToRun}` };
      }
      const whatToRun = ref.whatToRun;
      let scriptPath = '';
      if (whatToRun && typeof whatToRun === 'object') {
        if (whatToRun.kind === 'fs-path') scriptPath = whatToRun.value;
      } else if (typeof whatToRun === 'string' && whatToRun.startsWith('b64:')) {
        try {
          const parsed = parseRef(whatToRun);
          if (parsed.kind === 'fs-path') scriptPath = parsed.value;
        } catch {
          scriptPath = '';
        }
      }
      if (!scriptPath) {
        return { dispatched: false, error: `no fs-path in whatToRun: ${JSON.stringify(whatToRun)}` };
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
      const whatToRun = ref.whatToRun;
      let scriptPath = '';
      if (whatToRun && typeof whatToRun === 'object') {
        if (whatToRun.kind === 'fs-path') scriptPath = whatToRun.value;
      } else if (typeof whatToRun === 'string' && whatToRun.startsWith('b64:')) {
        try {
          const parsed = parseRef(whatToRun);
          if (parsed.kind === 'fs-path') scriptPath = parsed.value;
        } catch {
          scriptPath = '';
        }
      }
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

const serverMetaRef = process.env.DEMO_SERVER_META_STORE_REF || configuredServerMetaStoreRef || serializeRef({ kind: 'fs-path', value: setupDir });
const serverMetaAdapter = createFsBoardPlatformAdapter(
  parseRef(serverMetaRef), { suppressSpawn: true },
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

function buildBoardContextConfig(label, boardDir, taskExecPath, chatHandlerFlow, infAdapterPath, boardId) {
  fs.mkdirSync(boardDir, { recursive: true });

  // Runtime card store lives inside the board's setup dir, isolated from the source cards dir.
  // Layout: boardDir/cards/store  — KV card store
  //         boardDir/cards/chats  — chat blobs
  //         boardDir/cards/files  — file uploads
  const runtimeCardsDir = path.join(boardDir, 'cards');
  const runtimeCardStoreDir = path.join(runtimeCardsDir, 'store');
  fs.mkdirSync(runtimeCardStoreDir, { recursive: true });

  const notifyChannel = `yaml-flow-server-${label}-${boardId}-${process.pid}`;
  const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: boardDir }));
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, {
    notifyChannel,
  });
  // In the server context the drain loop is driven in-process; suppress the
  // detached CLI spawn that the FS adapter would otherwise fire as a continuation.
  boardAdapter.requestProcessAccumulated = () => {};
  // Artifacts adapter rooted at runtimeCardsDir so chats/ and files/ are siblings of store/.
  const artifactsRef = parseRef(serializeRef({ kind: 'fs-path', value: runtimeCardsDir }));
  const artifactsAdapter = createFsBoardPlatformAdapter(artifactsRef, { suppressSpawn: true });

  const cardStoreRef = serializeRef({ kind: 'fs-path', value: runtimeCardStoreDir });

  return {
    label,
    boardAdapter,
    artifactsAdapter,
    baseRef,
    cardStoreRef,
    outputsStoreRef: serializeRef({ kind: 'fs-path', value: path.join(path.dirname(boardDir), 'runtime-out', '.outputs') }),
    notifyRef: { kind: 'named-pipe', value: namedPipePath(notifyChannel) },
    taskExecutorRef: makeExecutionRef(taskExecPath, 'task-executor'),
    chatHandlerFlow,
    inferenceAdapterRef: makeExecutionRef(infAdapterPath, 'inference-adapter'),
  };
}

const runtime = createMultiBoardServerRuntime({
  apiBasePath,
  serverMetaStore,
  logger,
  boardRuntimeFactory: (boardId, entry) => {
    // sourceCardsDir: read-only source used only for initial seeding.
    const sourceCardsDir = typeof entry.cardsDir === 'string' ? path.resolve(entry.cardsDir) : defaultCardsDir;
    const boardRoot = path.join(setupDir, `board-${boardId}`);
    const boardDir = path.join(boardRoot, 'runtime');
    const flowRunner = createStepMachineChatFlowRunner({
      invokeRef: (ref, stepArgs) => invokeRefSync(ref, stepArgs, {
        cliDir: __dirname,
        cwd: __dirname,
        label: 'demo-chat-flow',
        timeoutMs: 120000,
      }),
    });

    const taskExecPath = typeof entry.taskExecutorPath === 'string' ? entry.taskExecutorPath : defaultTaskExecutorPath;
    const chatHandlerFlow = entry.chatHandlerFlow || loadJsonFromConfig(entry.chatHandlerFlowPath) || buildChatHandlerFlowFromScript(typeof entry.chatHandlerPath === 'string' ? entry.chatHandlerPath : null) || defaultChatHandlerFlow;
    const infAdapterPath = typeof entry.inferenceAdapterPath === 'string' ? entry.inferenceAdapterPath : defaultInferenceAdapterPath;
    const stepMachinePath = typeof entry.stepMachineCliPath === 'string' ? entry.stepMachineCliPath : defaultStepMachineCliPath;

    const sourceGandalfCardsDir = typeof entry.gandalfCardsDir === 'string' ? path.resolve(entry.gandalfCardsDir) : defaultGandalfCardsDir;
    const gandalfTaskExecPath = typeof entry.gandalfTaskExecutorPath === 'string' ? entry.gandalfTaskExecutorPath : defaultGandalfTaskExecutorPath;
    const gandalfChatFlow = entry.gandalfChatHandlerFlow || loadJsonFromConfig(entry.gandalfChatHandlerFlowPath) || buildChatHandlerFlowFromScript(typeof entry.gandalfChatHandlerPath === 'string' ? entry.gandalfChatHandlerPath : null) || defaultGandalfChatHandlerFlow;
    const gandalfInfPath = typeof entry.gandalfInferenceAdapterPath === 'string' ? entry.gandalfInferenceAdapterPath : defaultGandalfInferenceAdapterPath;

    const baseCfg = buildBoardContextConfig('base', boardDir, taskExecPath, chatHandlerFlow, infAdapterPath, boardId);

    const boards = [baseCfg];
    let gandalfBoardDir = null;
    if (sourceGandalfCardsDir && gandalfTaskExecPath) {
      gandalfBoardDir = path.join(boardRoot, 'gandalf-runtime');
      const gandalfCfg = buildBoardContextConfig('gandalf', gandalfBoardDir, gandalfTaskExecPath, gandalfChatFlow, gandalfInfPath, boardId);
      gandalfCfg.outputsStoreRef = serializeRef({ kind: 'fs-path', value: path.join(boardRoot, 'gandalf-runtime-out', '.outputs') });
      boards.push(gandalfCfg);
    }

    // Store host config for demo-setup (FS paths are host concerns)
    boardHostConfig.set(boardId, { cardsDir: sourceCardsDir, gandalfCardsDir: sourceGandalfCardsDir, boardDir, boardRoot });

    // Auto-run demo-setup (write copilot-instructions.md) at board init time,
    // so clients no longer need a separate /demo-setup request before bootstrapping.
    demoPrepSetup(boardId);

    // runtimeCardsDir is where the live card store lives (inside setupDir).
    const runtimeCardsDir = path.join(boardDir, 'cards');

    const singleBoardRuntime = createSingleBoardServerRuntime({
      apiBasePath: `${apiBasePath}/${boardId}`,
      boardId,
      boards,
      invocationAdapter,
      chatFlowRunner: flowRunner,
      notificationTransport,
      logger,
      serverUrl: `http://127.0.0.1:${PORT}`,
      executionExtra: {
        boardSetupRoot: boardRoot,
        chatsBlobBasePath: path.join(runtimeCardsDir, 'chats'),
        ...(stepMachinePath ? { stepMachineCliPath: stepMachinePath } : {}),
      },
    });

    // Host concern: seed card store from source cardsDir only if the runtime store is empty.
    const existing = singleBoardRuntime.cardStore.get({});
    const isEmpty = existing.status !== 'success' || !existing.data?.cards?.length;
    if (isEmpty) {
      const cards = createFsCardSource(sourceCardsDir, selectedCardsPattern).listCards();
      if (cards.length) singleBoardRuntime.cardStore.set({ body: cards });
    }
    // Seed gandalf board if present
    if (gandalfBoardDir && sourceGandalfCardsDir) {
      const gandalfRuntime = singleBoardRuntime.getBoardRuntime?.('gandalf');
      if (gandalfRuntime) {
        const gExisting = gandalfRuntime.cardStore.get({});
        const gEmpty = gExisting.status !== 'success' || !gExisting.data?.cards?.length;
        if (gEmpty) {
          const gCards = createFsCardSource(sourceGandalfCardsDir).listCards();
          if (gCards.length) gandalfRuntime.cardStore.set({ body: gCards });
        }
      }
    }

    return singleBoardRuntime;
  },
});


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
