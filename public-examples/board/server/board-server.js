#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMultiBoardServerRuntime,
  createSingleBoardServerRuntime,
} from 'yaml-flow/board-live-cards-server-runtime';

import {
  buildLocalBaseSpec,
  createFsBoardPlatformAdapter,
  createFsBoardNonCorePlatformAdapter,
  createFsBoardChatStorage,
  createNodeSpawnInvocationAdapter,
  createArtifactsStore,
  evaluateArgsMassaging,
  invokeExecutionRef,
  parseRef,
  registerInProcessExecutionHandler,
  startBoardWorkerQueueRunner,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';
import { registerInProcessBoardWorkerCallback } from 'yaml-flow/board-worker-adapter';
import {
  createStepMachineChatFlowRunner,
} from 'yaml-flow/step-machine-public';

const __filename = fileURLToPath(import.meta.url);
const SERVER_DIR = path.dirname(__filename);
const BOARD_ROOT = path.resolve(SERVER_DIR, '..');
const cliArgs = process.argv.slice(2);
const SERVER_CONFIG = path.join(BOARD_ROOT, 'server-config.json');

function loadServerConfig() {
  const cliConfigIndex = cliArgs.indexOf('--config');
  const cliConfigPath = cliConfigIndex !== -1 ? cliArgs[cliConfigIndex + 1] : '';
  const configuredPath = String(cliConfigPath || '').trim();
  const configPath = configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.join(BOARD_ROOT, configuredPath))
    : SERVER_CONFIG;
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
  return path.resolve(BOARD_ROOT, configValue);
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

function normalizeTimeoutMs(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function pickTimeoutMs(...values) {
  for (const value of values) {
    const n = normalizeTimeoutMs(value, null);
    if (n !== null) return n;
  }
  return null;
}

function applyFlowTimeout(flow, timeoutMs) {
  if (!flow || typeof flow !== 'object') return flow;
  const normalized = normalizeTimeoutMs(timeoutMs, null);
  if (normalized === null) return flow;
  return {
    ...flow,
    settings: {
      ...(flow.settings && typeof flow.settings === 'object' ? flow.settings : {}),
      timeout_ms: normalized,
    },
  };
}

function buildChatHandlerFlowFromScript(scriptPath, timeoutMs = null) {
  if (!scriptPath) return null;
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(BOARD_ROOT, scriptPath);
  const resolvedTimeoutMs = normalizeTimeoutMs(timeoutMs, 300000);
  return {
    id: 'demo-chat-script-handler',
    settings: { start_step: 'respond', max_total_steps: 5, timeout_ms: resolvedTimeoutMs },
    steps: {
      respond: {
        description: 'Run the demo board chat responder from a script path',
        handler: {
          type: 'ref',
          howToRun: 'local-node',
          whatToRun: { kind: 'fs-path', value: resolved },
          meta: 'chat-handler',
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
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(BOARD_ROOT, rawPath);
    return serializeRef({ kind: 'fs-path', value: resolved });
  } catch {
    return trimmed;
  }
}

const serverConfig = loadServerConfig();
const configuredChatFlowTimeoutMs = normalizeTimeoutMs(serverConfig.chatFlowTimeoutMs, null);
const configuredInvokeRefTimeoutMs = normalizeTimeoutMs(serverConfig.chatInvokeRefTimeoutMs, 300000);
const configuredCopilotTimeoutMs = normalizeTimeoutMs(serverConfig.chatCopilotTimeoutMs, 300000);

function normalizeBoardWorkerTransport(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'http') return 'http';
  if (normalized === 'queue') return 'queue';
  return 'in-process-loop';
}

const configuredBoardWorkerTransport = normalizeBoardWorkerTransport(
  process.env.DEMO_TASK_EXECUTOR_TRANSPORT || serverConfig.taskExecutorTransport || 'in-process-loop',
);

// Resolve top-level config defaults (used as fallbacks for per-board config)
const configuredTaskExecutorPath = resolveFromConfig(serverConfig.taskExecutorPath);
const configuredChatHandlerPath = resolveFromConfig(serverConfig.chatHandlerPath);
const configuredFlowFromPath = loadJsonFromConfig(serverConfig.chatHandlerFlowPath);
const configuredChatHandlerFlow = applyFlowTimeout(
  configuredFlowFromPath || buildChatHandlerFlowFromScript(configuredChatHandlerPath, configuredChatFlowTimeoutMs),
  configuredChatFlowTimeoutMs,
);
const configuredInferenceAdapterPath = resolveFromConfig(serverConfig.inferenceAdapterPath);
const configuredStepMachineCliPath = resolveFromConfig(serverConfig.stepMachineCliPath);
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
const enableTestReq = /^(1|true|yes|on)$/i.test((process.env.BOARD_SERVER_ENABLE_TEST_REQ || '').trim());

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

// ---------------------------------------------------------------------------
// Setup directory
// ---------------------------------------------------------------------------

const setupDir = path.resolve(
  process.env.DEMO_SETUP_DIR || path.join(BOARD_ROOT, '.demo-setup'),
);
fs.mkdirSync(setupDir, { recursive: true });

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

function makeExecutionRef(scriptPath, extra) {
  if (!scriptPath) return undefined;
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);
  return {
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: resolved }),
    ...(extra !== undefined ? { meta: extra } : {}),
  };
}

function makeLocalTaskExecutorRef(scriptPath, extra) {
  if (!scriptPath) return undefined;
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);
  return {
    meta: 'task-executor',
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: resolved }),
    ...(extra !== undefined ? { extra } : {}),
  };
}

function isHostedTaskExecutorRef(ref) {
  return ref?.howToRun === 'queue-storage'
    || ref?.howToRun === 'in-process-loop'
    || ref?.howToRun === 'http:post'
    || ref?.howToRun === 'http:get';
}

function makeHostedBoardWorkerRef(boardId, taskExecPath, transport, executionExtra) {
  if (!taskExecPath) return undefined;
  if (transport === 'in-process-loop') {
    return {
      meta: 'task-executor',
      howToRun: 'in-process-loop',
      whatToRun: serializeRef({ kind: 'in-process-loop', value: `board:${boardId}:board-worker` }),
    };
  }
  if (transport === 'http') {
    return {
      meta: 'task-executor',
      howToRun: 'http:post',
      whatToRun: serializeRef({
        kind: 'http-url',
        value: `${String(executionExtra.serverUrl || '').replace(/\/+$/, '')}/api/board-worker`,
      }),
      extra: { boardId },
    };
  }
  if (transport === 'queue') {
    return {
      meta: 'task-executor',
      howToRun: 'queue-storage',
      whatToRun: serializeRef({ kind: 'queue-storage', value: `board:${boardId}:board-worker` }),
      extra: { boardId },
    };
  }
  throw new Error(`Unsupported board-worker transport for demo host: ${transport}`);
}

function makeBoardWorkerCallbackSelfRef(serverUrl, boardApiBasePath, transport, boardId) {
  if (transport === 'in-process-loop' || transport === 'queue') {
    return {
      meta: 'board-live-cards',
      howToRun: 'in-process-loop',
      whatToRun: serializeRef({ kind: 'in-process-loop', value: `board:${boardId}:board-worker-callback` }),
    };
  }
  const normalizedServerUrl = typeof serverUrl === 'string' ? serverUrl.trim().replace(/\/+$/, '') : '';
  const normalizedApiBasePath = typeof boardApiBasePath === 'string' ? boardApiBasePath.trim().replace(/\/+$/, '') : '';
  if (!normalizedServerUrl || !normalizedApiBasePath) return undefined;
  return {
    meta: 'board-live-cards',
    howToRun: 'http:post',
    whatToRun: serializeRef({
      kind: 'http-url',
      value: `${normalizedServerUrl}${normalizedApiBasePath}/callback/board-worker`,
    }),
  };
}

async function readJsonRequest(req) {
  const parts = [];
  for await (const chunk of req) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(parts).toString('utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

const boardWorkerModuleCache = new Map();

async function loadBoardWorkerModule(taskExecPath) {
  const resolved = path.isAbsolute(taskExecPath) ? taskExecPath : path.resolve(BOARD_ROOT, taskExecPath);
  if (!boardWorkerModuleCache.has(resolved)) {
    boardWorkerModuleCache.set(resolved, import(pathToFileURL(resolved).href));
  }
  return boardWorkerModuleCache.get(resolved);
}

function createHostedBoardWorkerDispatcher(boardId, taskExecPath) {
  if (!taskExecPath) return null;
  return async (request) => {
    const mod = await loadBoardWorkerModule(taskExecPath);
    if (typeof mod.executeBoardWorkerRequest === 'function') {
      return await mod.executeBoardWorkerRequest(request);
    }
    if (typeof mod.executeTaskExecutorRequest === 'function') {
      return await mod.executeTaskExecutorRequest(request);
    }
    throw new Error(`Hosted board worker for board ${boardId} must export executeBoardWorkerRequest(request)`);
  };
}

function createNamedPipeNotificationTransport() {
  return {
    async subscribe(ref, onEvent) {
      if (ref.kind !== 'named-pipe') return () => {};
      const pipePath = ref.value;
      if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
        try { fs.rmSync(pipePath, { force: true }); } catch { /* */ }
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
            try { onEvent(JSON.parse(line)?.notification ?? JSON.parse(line)); } catch { /* */ }
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
          try { fs.rmSync(pipePath, { force: true }); } catch { /* */ }
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
const hostedBoardWorkerDispatchers = new Map();
const hostedBoardWorkerQueueStops = new Map();
const hostedBoardChatStorages = new Map();

// Map config keys to board entries for the factory
const boardConfigEntries = serverConfig.boards ? Object.entries(serverConfig.boards) : [];
const boardConfigMap = new Map(boardConfigEntries);

function buildBoardContextConfig(label, boardDir, taskExecPath, chatHandlerFlow, infAdapterPath, boardId, executionExtra = {}) {
  fs.mkdirSync(boardDir, { recursive: true });
  const runtimeCardsDir = path.join(path.dirname(boardDir), 'cards');
  const runtimeCardStoreDir = path.join(runtimeCardsDir, 'store');
  fs.mkdirSync(runtimeCardStoreDir, { recursive: true });
  const runtimeOutDir = path.join(path.dirname(boardDir), 'runtime-out');
  const scratchDir = path.join(runtimeOutDir, '.tmp');
  const archiveDir = path.join(runtimeOutDir, 'archive');
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const notifyChannel = `yaml-flow-server-${label}-${boardId}-${process.pid}`;
  const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: boardDir }));
  const boardWorkerTransport = normalizeBoardWorkerTransport(executionExtra.taskExecutorTransport);
  const callbackSelfRef = makeBoardWorkerCallbackSelfRef(executionExtra.serverUrl, executionExtra.apiBasePath, boardWorkerTransport, boardId);
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, {
    notifyChannel,
    ...(callbackSelfRef ? { selfRef: callbackSelfRef } : {}),
  });
  const nonCoreAdapter = createFsBoardNonCorePlatformAdapter(baseRef, {
    notifyChannel,
    ...(callbackSelfRef ? { selfRef: callbackSelfRef } : {}),
  });
  const localSyncTaskExecutorRef = makeLocalTaskExecutorRef(taskExecPath, executionExtra);
  if (localSyncTaskExecutorRef) {
    const invokeExecutor = nonCoreAdapter.invokeExecutor.bind(nonCoreAdapter);
    nonCoreAdapter.invokeExecutor = (ref, subcommand, execOpts) => {
      const syncRef = isHostedTaskExecutorRef(ref) ? localSyncTaskExecutorRef : ref;
      return invokeExecutor(syncRef, subcommand, execOpts);
    };
  }
  boardAdapter.requestProcessAccumulated = () => {};
  nonCoreAdapter.requestProcessAccumulated = () => {};

  const artifactsRef = parseRef(serializeRef({ kind: 'fs-path', value: runtimeCardsDir }));
  const artifactsAdapter = createFsBoardPlatformAdapter(artifactsRef, { suppressSpawn: true });
  const artifactsStoreRef = serializeRef({ kind: 'fs-path', value: runtimeCardsDir });
  const cardStoreRef = serializeRef({ kind: 'fs-path', value: runtimeCardStoreDir });
  const scratchStoreRef = serializeRef({ kind: 'fs-path', value: scratchDir });
  const archiveStoreRef = serializeRef({ kind: 'fs-path', value: archiveDir });

  return {
    label,
    boardAdapter,
    nonCoreAdapter,
    artifactsAdapter,
    baseRef,
    cardStoreRef,
    outputsStoreRef: serializeRef({ kind: 'fs-path', value: runtimeOutDir }),
    artifactsStoreRef,
    scratchStoreRef,
    archiveStoreRef,
    notifyRef: { kind: 'named-pipe', value: namedPipePath(notifyChannel) },
    taskExecutorRef: makeHostedBoardWorkerRef(boardId, taskExecPath, boardWorkerTransport, executionExtra),
    chatHandlerFlow,
    inferenceAdapterRef: makeExecutionRef(infAdapterPath),
  };
}

// Pre-register configured boards in the server meta store
const persistedBoardsConfigText = serverMetaStore.getText('boards-config.json');
let persistedBoardsConfig = { boards: [] };
if (persistedBoardsConfigText) {
  try {
    const parsedBoardsConfig = JSON.parse(persistedBoardsConfigText);
    if (parsedBoardsConfig && Array.isArray(parsedBoardsConfig.boards)) {
      persistedBoardsConfig = parsedBoardsConfig;
    }
  } catch {
    persistedBoardsConfig = { boards: [] };
  }
}

const persistedBoardsById = new Map(
  (persistedBoardsConfig.boards || []).map((board) => [board?.id, board])
);

for (const [key, cfg] of boardConfigEntries) {
  const existing = serverMetaStore.getText(`boards/${key}.json`);
  if (!existing) {
    serverMetaStore.putText(`boards/${key}.json`, JSON.stringify({ id: key, label: cfg.label || key }));
  }

  persistedBoardsById.set(key, {
    ...(persistedBoardsById.get(key) || {}),
    id: key,
    label: cfg.label || key,
  });
}

serverMetaStore.putText(
  'boards-config.json',
  JSON.stringify({ boards: Array.from(persistedBoardsById.values()) }, null, 2)
);

/**
 * Thin wrapper around the shared execution-ref invoker that pins the board
 * server's cliDir/cwd/label defaults for chat-flow steps.
 */
function invokeExecutionRefAsync(ref, args, opts) {
  return invokeExecutionRef(ref, args, {
    cliDir: opts?.cliDir || BOARD_ROOT,
    cwd: opts?.cwd || BOARD_ROOT,
    timeoutMs: typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : undefined,
    label: 'board-server-chat-flow',
  });
}

const runtime = createMultiBoardServerRuntime({
  apiBasePath,
  serverMetaStore,
  logger,
  boardRuntimeFactory: (boardId, entry) => {
    const cfg = boardConfigMap.get(boardId);
    const regular = cfg?.regular || {};

    const cardsDir = resolveFromConfig(regular.seedCardsDir) || (entry?.cardsDir ? path.resolve(entry.cardsDir) : null);
    const taskExecPath = resolveFromConfig(regular.taskExecutorPath) || (entry?.taskExecutorPath || configuredTaskExecutorPath);
    const chatHandlerPath = resolveFromConfig(regular.chatHandlerPath) || (entry?.chatHandlerPath || configuredChatHandlerPath);
    const boardFlowTimeoutMs = configuredChatFlowTimeoutMs;
    const chatHandlerFlow = applyFlowTimeout(
      loadJsonFromConfig(regular.chatHandlerFlowPath)
        || entry?.chatHandlerFlow
        || buildChatHandlerFlowFromScript(chatHandlerPath, boardFlowTimeoutMs)
        || configuredChatHandlerFlow,
      boardFlowTimeoutMs,
    );
    const infAdapterPath = resolveFromConfig(regular.inferenceAdapterPath) || (entry?.inferenceAdapterPath || configuredInferenceAdapterPath);
    const stepMachinePath = resolveFromConfig(regular.stepMachineCliPath || cfg?.stepMachineCliPath) || (entry?.stepMachineCliPath || configuredStepMachineCliPath);
    const boardWorkerTransport = normalizeBoardWorkerTransport(regular.taskExecutorTransport || entry?.taskExecutorTransport || configuredBoardWorkerTransport);
    const chatInvokeRefTimeoutMs = configuredInvokeRefTimeoutMs;
    const chatCopilotTimeoutMs = configuredCopilotTimeoutMs;

    if (chatHandlerPath && !process.env.DEMO_CHAT_HANDLER_PATH) {
      process.env.DEMO_CHAT_HANDLER_PATH = chatHandlerPath;
    }
    if (infAdapterPath && !process.env.DEMO_INFERENCE_ADAPTER_PATH) {
      process.env.DEMO_INFERENCE_ADAPTER_PATH = infAdapterPath;
    }

    const boardSetupRootOverride = (process.env.DEMO_BOARD_SETUP_ROOT || '').trim();
    const boardRoot = boardSetupRootOverride
      ? path.resolve(boardSetupRootOverride, `board-${boardId}`)
      : (cfg?.setupDir ? path.resolve(BOARD_ROOT, cfg.setupDir) : path.join(setupDir, `board-${boardId}`));
    const chatFlowRoot = path.resolve(BOARD_ROOT, 'server', 'chat-flow');
    fs.mkdirSync(boardRoot, { recursive: true });
    const boardDir = path.join(boardRoot, 'runtime');
    const runtimeCardsDir = path.join(boardRoot, 'cards');
    const flowRunner = createStepMachineChatFlowRunner({
      invokeRef: (ref, stepArgs) => invokeExecutionRefAsync(ref, stepArgs, {
        cliDir: BOARD_ROOT,
        cwd: BOARD_ROOT,
        timeoutMs: chatInvokeRefTimeoutMs,
      }),
    });
    const baseExecutionExtra = {
      boardSetupRoot: boardRoot,
      boardBaseRef: serializeRef({ kind: 'fs-path', value: boardDir }),
      boardRuntimeDir: 'runtime',
      runtimeStatusDir: 'runtime-out',
      cardsDir: 'cards',
      projectRoot: BOARD_ROOT,
      chatFlowRoot,
      apiBasePath: `${apiBasePath}/${boardId}`,
      serverUrl: `http://127.0.0.1:${PORT}`,
      taskExecutorTransport: boardWorkerTransport,
      chatCopilotTimeoutMs,
      ...(stepMachinePath ? { stepMachineCliPath: stepMachinePath } : {}),
    };

    const baseCfg = buildBoardContextConfig('base', boardDir, taskExecPath, chatHandlerFlow, infAdapterPath, boardId, baseExecutionExtra);
    const boards = [baseCfg];

    demoPrepSetup({ cardsDir, boardDir });

    const chatStorage = createFsBoardChatStorage(boardDir);
    hostedBoardChatStorages.set(boardId, chatStorage);

    const singleBoardRuntime = createSingleBoardServerRuntime({
      apiBasePath: `${apiBasePath}/${boardId}`,
      boardId,
      chatStorage,
      boards,
      invocationAdapter,
      chatFlowRunner: flowRunner,
      notificationTransport,
      logger,
      serverUrl: `http://127.0.0.1:${PORT}`,
      executionExtra: {
        boardSetupRoot: boardRoot,
        boardBaseRef: serializeRef({ kind: 'fs-path', value: boardDir }),
        boardRuntimeDir: 'runtime',
        runtimeStatusDir: 'runtime-out',
        cardsDir: 'cards',
        projectRoot: BOARD_ROOT,
        chatFlowRoot,
        chatCopilotTimeoutMs,
        ...(stepMachinePath ? { stepMachineCliPath: stepMachinePath } : {}),
      },
    });

    const hostedBoardWorkerDispatch = createHostedBoardWorkerDispatcher(boardId, taskExecPath);
    if (hostedBoardWorkerDispatch) {
      hostedBoardWorkerDispatchers.set(boardId, hostedBoardWorkerDispatch);
    }
    const previousQueueStop = hostedBoardWorkerQueueStops.get(boardId);
    if (previousQueueStop) {
      previousQueueStop();
      hostedBoardWorkerQueueStops.delete(boardId);
    }
    if (boardWorkerTransport === 'in-process-loop' && hostedBoardWorkerDispatch) {
      registerInProcessExecutionHandler(`board:${boardId}:board-worker`, async (_ref, args) => {
        void hostedBoardWorkerDispatch(args).catch((err) => {
          logger.error(`[board-server] in-process board-worker failed for ${boardId}: ${String(err && err.message || err)}`);
        });
        return { result: 'success', data: { dispatched: true } };
      });
    }
    if ((boardWorkerTransport === 'in-process-loop' || boardWorkerTransport === 'queue') && hostedBoardWorkerDispatch) {
      registerInProcessBoardWorkerCallback(`board:${boardId}:board-worker-callback`, (payload) => {
        if (payload.outcome === 'success') {
          return singleBoardRuntime.reportSourceFetched(payload.token, String(payload.ref || ''));
        }
        return singleBoardRuntime.reportSourceFetchFailure(payload.token, String(payload.reason || 'unknown'));
      });
    }
    if (boardWorkerTransport === 'queue' && hostedBoardWorkerDispatch) {
      const stopQueueRunner = startBoardWorkerQueueRunner({
        workerStore: baseCfg.boardAdapter.boardWorkerStore(),
        executeBoardWorkerRequest: hostedBoardWorkerDispatch,
        onError: (error, lease) => {
          logger.error(
            `[board-server] queued board-worker failed for ${boardId} (attempt ${lease.attempt}): ${String(error && error.message || error)}`,
          );
        },
      });
      hostedBoardWorkerQueueStops.set(boardId, stopQueueRunner);
    }

    // Seed card store from source cardsDir if empty
    const existing = singleBoardRuntime.cardStore.get({});
    const isEmpty = existing.status !== 'success' || !existing.data?.cards?.length;
    if (isEmpty && cardsDir) {
      const cards = createFsCardSource(cardsDir, selectedCardsPattern).listCards();
      if (cards.length) singleBoardRuntime.cardStore.set({ body: cards });
    }

    return singleBoardRuntime;
  },
});

// ---------------------------------------------------------------------------
// Host setup — writes copilot-instructions.md into the board setup root.
// ---------------------------------------------------------------------------

function demoPrepSetup({ cardsDir, boardDir }) {
  if (!cardsDir) return;

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
}

function jsonReply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const testSystemChatMatch = pathname.match(/^\/test-req\/boards\/([^/]+)\/chat\/system-message$/);
  if (method === 'POST' && testSystemChatMatch) {
    if (!enableTestReq) {
      jsonReply(res, 404, { error: 'Not found' });
      return;
    }

    try {
      const boardId = decodeURIComponent(testSystemChatMatch[1]);
      runtime.requireBoardService(boardId);
      const chatStorage = hostedBoardChatStorages.get(boardId);
      if (!chatStorage) {
        jsonReply(res, 409, { error: `No hosted chat storage configured for board: ${boardId}` });
        return;
      }

      const body = await readJsonRequest(req);
      const cardId = typeof body?.cardId === 'string' ? body.cardId.trim() : '';
      const text = typeof body?.text === 'string' ? body.text : '';
      const turn = typeof body?.turn === 'string' ? body.turn : '';
      const files = Array.isArray(body?.files) ? body.files : [];

      if (!cardId) {
        jsonReply(res, 400, { error: 'cardId is required' });
        return;
      }
      if (typeof body?.text !== 'string') {
        jsonReply(res, 400, { error: 'text is required' });
        return;
      }

      const id = chatStorage.append(cardId, 'system', text, files, turn);
      jsonReply(res, 200, {
        status: 'success',
        data: {
          id,
          boardId,
          cardId,
          role: 'system',
          text,
          turn,
          files,
        },
      });
      return;
    } catch (err) {
      jsonReply(res, 404, { error: String(err && err.message || err) });
      return;
    }
  }

  if (method === 'POST' && pathname === '/api/board-worker') {
    try {
      const body = await readJsonRequest(req);
      const boardId = typeof body?.extra?.boardId === 'string' ? body.extra.boardId.trim() : '';
      if (!boardId) {
        jsonReply(res, 400, { error: 'boardId is required in request.extra.boardId' });
        return;
      }
      runtime.requireBoardService(boardId);
      const dispatcher = hostedBoardWorkerDispatchers.get(boardId);
      if (!dispatcher) {
        jsonReply(res, 409, { error: `No hosted board-worker configured for board: ${boardId}` });
        return;
      }
      if (body?.source_def) {
        void dispatcher(body).catch((err) => {
          logger.error(`[board-server] hosted board-worker failed for ${boardId}: ${String(err && err.message || err)}`);
        });
        jsonReply(res, 202, { status: 'success', dispatched: true });
        return;
      }
      const workerResult = await dispatcher(body);
      jsonReply(res, 200, workerResult ?? { status: 'success', data: {} });
      return;
    } catch (err) {
      jsonReply(res, 404, { error: String(err && err.message || err) });
      return;
    }
  }

  // All other /api/boards routes are handled by the platform-free runtime
  runtime.handleApi(req, res, url).then((handled) => {
    if (!handled) {
      jsonReply(res, 404, { error: 'Not found' });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[board-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[board-server] setup dir: ${setupDir}`);
  console.log(`[board-server] server-meta store: ${serverMetaRef}`);
  console.log('[board-server] endpoints:');
  console.log(`  GET  ${apiBasePath}                          <- list boards`);
  console.log(`  POST ${apiBasePath}  {id, label?}            <- register board`);
  console.log(`  GET  ${apiBasePath}/:boardId/init-board`);
  console.log(`  GET  ${apiBasePath}/:boardId/sse`);
  console.log(`  GET  ${apiBasePath}/:boardId/board-status`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id`);
  console.log(`  PATCH ${apiBasePath}/:boardId/cards/:id`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/actions   <- card actions, including chat-send`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/files`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id/files/:idx`);
  console.log(`  GET  ${apiBasePath}/:boardId/cards/:id/chats`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/chats/subscribe-sse`);
  console.log(`  POST ${apiBasePath}/:boardId/cards/:id/chats/unsubscribe-sse`);
  console.log('  POST /api/board-worker');
  if (enableTestReq) {
    console.log('  POST /test-req/boards/:boardId/chat/system-message');
  }
});