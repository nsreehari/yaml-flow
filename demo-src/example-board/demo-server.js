#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  createMultiBoardServerRuntime,
  createRuntimeRequestDispatcher,
  isRuntimeRoute,
} from 'yaml-flow/board-livecards-server-runtime';

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
const _pkgCliJs = _yamlFlowDir ? path.join(_yamlFlowDir, 'board-live-cards-cli.js') : null;
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

const serverConfig = loadServerConfig();
const configuredCliJs = resolveFromConfig(serverConfig.boardLiveCardsCliJs) || _pkgCliJs;
const configuredCardsDir = resolveFromConfig(serverConfig.cardsDir);
const configuredTaskExecutorPath = resolveFromConfig(serverConfig.taskExecutorPath || serverConfig.demoTaskExecutorPath);
const configuredStepMachineCliPath = resolveFromConfig(serverConfig.stepMachineCliPath) || _pkgStepMachineCli;
const configuredChatHandlerPath = resolveFromConfig(serverConfig.chatHandlerPath);
const configuredInferenceAdapterPath = resolveFromConfig(serverConfig.inferenceAdapterPath);
const configuredGandalfCardsDir = resolveFromConfig(serverConfig.gandalfCardsDir);
const configuredGandalfTaskExecutorPath = resolveFromConfig(serverConfig.gandalfTaskExecutorPath);
const configuredGandalfChatHandlerPath = resolveFromConfig(serverConfig.gandalfChatHandlerPath);
const configuredGandalfInferenceAdapterPath = resolveFromConfig(serverConfig.gandalfInferenceAdapterPath);

if (!process.env.BOARD_LIVE_CARDS_CLI_JS && configuredCliJs) {
  process.env.BOARD_LIVE_CARDS_CLI_JS = configuredCliJs;
}
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

const runtime = createMultiBoardServerRuntime({
  apiBasePath: '/api/boards',
  serverUrl: `http://127.0.0.1:${PORT}`,
  defaultCardsDir: process.env.DEMO_CARDS_DIR || configuredCardsDir || null,
  defaultTaskExecutorPath: process.env.DEMO_TASK_EXECUTOR_PATH || configuredTaskExecutorPath || null,
  defaultStepMachineCliPath: process.env.DEMO_STEP_MACHINE_CLI_PATH || configuredStepMachineCliPath,
  defaultChatHandlerPath: process.env.DEMO_CHAT_HANDLER_PATH || configuredChatHandlerPath || null,
  defaultInferenceAdapterPath: process.env.DEMO_INFERENCE_ADAPTER_PATH || configuredInferenceAdapterPath || null,
  defaultGandalfCardsDir: process.env.DEMO_GANDALF_CARDS_DIR || configuredGandalfCardsDir || null,
  defaultGandalfTaskExecutorPath: process.env.DEMO_GANDALF_TASK_EXECUTOR_PATH || configuredGandalfTaskExecutorPath || null,
  defaultGandalfChatHandlerPath: process.env.DEMO_GANDALF_CHAT_HANDLER_PATH || configuredGandalfChatHandlerPath || null,
  defaultGandalfInferenceAdapterPath: process.env.DEMO_GANDALF_INFERENCE_ADAPTER_PATH || configuredGandalfInferenceAdapterPath || null,
  boardLiveCardsCliJs: process.env.BOARD_LIVE_CARDS_CLI_JS || configuredCliJs,
});

function resetRuntime() {
  const setupDir = runtime.setupDir;
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

const dispatch = createRuntimeRequestDispatcher(runtime);

// Board-id segment regex: /api/boards/:boardId/...
const BOARD_SEG_RE = /^\/api\/boards\/([^/]+)\/(.+)$/;

function jsonReply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Card preparation — host-level concern, not a reusable runtime concern.
// Copies source card JSON files into the runtime's tmpCardsDir and writes
// the concatenated copilot-instructions.md at the board setup root.
// The runtime's bootstrap operations assume cards are already in tmpCardsDir;
// the host (this file) decides how and when they get there.
// ---------------------------------------------------------------------------

const _demoPrepSetupDone = new Map(); // boardId → true

function isDemoSetupDone(boardId, service) {
  return _demoPrepSetupDone.get(boardId) === true && fs.existsSync(service.tmpCardsDir);
}

function demoPrepSetup(boardId, service) {
  const { tmpSurfaceDir, tmpCardsDir, cardsDir, gandalfCardsDir, tmpGandalfCardsDir, boardDir } = service;

  fs.mkdirSync(tmpSurfaceDir, { recursive: true });
  fs.rmSync(tmpCardsDir, { recursive: true, force: true });
  fs.mkdirSync(tmpCardsDir, { recursive: true });

  const entries = fs.readdirSync(cardsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.json')) continue;
    fs.copyFileSync(path.join(cardsDir, entry.name), path.join(tmpCardsDir, entry.name));
  }

  // Copy gandalf-card templates if gandalfCardsDir is configured.
  if (gandalfCardsDir && fs.existsSync(gandalfCardsDir)) {
    fs.rmSync(tmpGandalfCardsDir, { recursive: true, force: true });
    fs.mkdirSync(tmpGandalfCardsDir, { recursive: true });
    for (const entry of fs.readdirSync(gandalfCardsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      fs.copyFileSync(path.join(gandalfCardsDir, entry.name), path.join(tmpGandalfCardsDir, entry.name));
    }
  }

  // Concatenate agent-instructions*.md into copilot-instructions.md at boardSetupRoot.
  const boardSetupRoot = path.dirname(boardDir);
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

async function handleDemoSetup(req, res, boardId) {
  try {
    const { service } = runtime.requireBoardService(boardId);
    let setupPerformed = false;

    if (!isDemoSetupDone(boardId, service)) {
      demoPrepSetup(boardId, service);
      setupPerformed = true;
    }

    jsonReply(res, 200, { ok: true, setupPerformed });
  } catch (err) {
    jsonReply(res, err.statusCode || 500, { error: String((err && err.message) || err) });
  }
}

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

  // Server has TTY on stdin — workiq can produce output.
  // Use async spawn (not spawnSync) to avoid blocking the event loop during the call.
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

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

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

  // All other /api/boards routes are handled by the reusable runtime
  void dispatch(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[demo-server] setup dir: ${runtime.setupDir}`);
  console.log(`[demo-server] boards config: ${runtime.setupDir}/boards-config.json`);
  console.log('[demo-server] endpoints:');
  console.log(`  GET  ${runtime.apiBasePath}                          <- list boards`);
  console.log(`  POST ${runtime.apiBasePath}  {id, label?}            <- register board`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/demo-setup`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/bootstrap`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/sse`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/board-status`);
  console.log(`  PATCH ${runtime.apiBasePath}/:boardId/cards/:id`);
  console.log(`  POST ${runtime.apiBasePath}/:boardId/cards/:id/actions`);
  console.log(`  POST ${runtime.apiBasePath}/:boardId/cards/:id/files`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/cards/:id/files/:idx`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/cards/:id/chats`);
  console.log(`  POST /api/workiq/ask  {query}              <- WorkIQ (M365 Copilot) proxy`);
});
