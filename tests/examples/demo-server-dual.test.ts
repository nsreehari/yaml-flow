/**
 * demo-server-dual.test.ts
 *
 * Runs the same HTTP endpoint assertions against BOTH:
 *   1. demo-server.js   (Node)
 *   2. py-demo-server.py (Python)
 *
 * Uses describe.each to iterate over both server modes so any parity
 * break between the two implementations is caught in one test run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveExampleBoardDir(): string {
  const candidates = [
    path.join(repoRoot, 'examples', 'example-board'),
    path.join(repoRoot, 'demo-src', 'example-board'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'cards'))) {
      return candidate;
    }
  }
  throw new Error(`Could not resolve example-board directory from: ${candidates.join(', ')}`);
}

const exampleBoardDir = resolveExampleBoardDir();
const SOURCE_CARDS_DIR = path.join(exampleBoardDir, 'cards');

// ── Server mode definitions ─────────────────────────────────────────────────

interface ServerMode {
  label: string;
  /** Command + args to spawn the server */
  cmd: string;
  args: string[];
  /** Extra env vars beyond the common ones */
  extraEnv?: Record<string, string>;
  /** Path to the echo chat-handler for this mode */
  echoHandlerExt: 'mjs' | 'py';
}

function findPython(): string {
  // Prefer python from PATH; fall back to known locations
  const candidates = [
    'python',
    'python3',
    process.env.PYTHON_PATH || '',
    'C:\\Users\\sreenaga\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const result = require('node:child_process').spawnSync(c!, ['--version'], { timeout: 3000 });
      if (result.status === 0) return c!;
    } catch { /* skip */ }
  }
  return 'python';
}

const pythonBin = findPython();
const nodeServerPath = path.join(exampleBoardDir, 'demo-server.js');
const pyServerPath = path.join(exampleBoardDir, 'py-demo-server.py');

const modes: ServerMode[] = [];

if (fs.existsSync(nodeServerPath)) {
  // Only include node mode if the dist/ build exists (worktrees may not have it)
  const distDir = path.join(repoRoot, 'dist', 'server-runtime');
  if (fs.existsSync(distDir)) {
    modes.push({
      label: 'node (demo-server.js)',
      cmd: process.execPath,
      args: [nodeServerPath],
      echoHandlerExt: 'mjs',
    });
  }
}

if (fs.existsSync(pyServerPath)) {
  modes.push({
    label: 'python (py-demo-server.py)',
    cmd: pythonBin,
    args: [pyServerPath],
    echoHandlerExt: 'py',
  });
}

if (modes.length === 0) {
  throw new Error('Neither demo-server.js nor py-demo-server.py found');
}

// ── Echo chat-handler sources ───────────────────────────────────────────────

const ECHO_HANDLER_NODE_SRC = `#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
const args = process.argv.slice(2);
function getArg(name) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; }
const extraStr = getArg('--extraEncJson') || '';
let extra = {};
try { extra = JSON.parse(Buffer.from(extraStr, 'base64').toString('utf-8')); } catch {}
const { chatDir, lastChatFile } = extra;
if (!chatDir || !lastChatFile) process.exit(0);
let lastUserText = '';
try {
  const files = fs.readdirSync(chatDir).filter(f => /_user\\.txt$/.test(f)).sort();
  if (files.length) lastUserText = fs.readFileSync(path.join(chatDir, files[files.length - 1]), 'utf-8').trim();
} catch {}
if (!/chat-handler test/.test(lastUserText)) process.exit(0);
const serial = parseInt(String(lastChatFile).match(/^(\\d+)/)?.[1] ?? '0', 10) + 1;
const outFile = path.join(chatDir, String(serial).padStart(3,'0') + '_assistant.txt');
fs.writeFileSync(outFile, 'Echoing: ' + lastUserText + '\\n', 'utf-8');
`;

const ECHO_HANDLER_PYTHON_SRC = `#!/usr/bin/env python3
import sys, os, json, base64, re

def get_arg(name):
    args = sys.argv[1:]
    try:
        idx = args.index(name)
        return args[idx + 1] if idx + 1 < len(args) else None
    except ValueError:
        return None

extra_str = get_arg('--extraEncJson') or ''
extra = {}
try:
    extra = json.loads(base64.b64decode(extra_str).decode('utf-8'))
except Exception:
    pass

chat_dir = extra.get('chatDir')
last_chat_file = extra.get('lastChatFile')
if not chat_dir or not last_chat_file:
    sys.exit(0)

last_user_text = ''
try:
    files = sorted(f for f in os.listdir(chat_dir) if re.search(r'_user\\.txt$', f))
    if files:
        with open(os.path.join(chat_dir, files[-1]), 'r', encoding='utf-8') as fh:
            last_user_text = fh.read().strip()
except Exception:
    pass

if 'chat-handler test' not in last_user_text:
    sys.exit(0)

m = re.match(r'^(\\d+)', str(last_chat_file))
serial = (int(m.group(1)) if m else 0) + 1
out_file = os.path.join(chat_dir, f'{serial:03d}_assistant.txt')
with open(out_file, 'w', encoding='utf-8') as fh:
    fh.write('Echoing: ' + last_user_text + '\\n')
`;

// ── Test suite per mode ─────────────────────────────────────────────────────

describe.each(modes)('demo-server parity [$label]', (mode) => {
  const TEST_PORT = 7800 + Math.floor(Math.random() * 100);
  const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `yaml-flow-dual-${mode.echoHandlerExt}-`));
  const SETUP_DIR = path.join(TEST_ROOT, 'setup');
  const TMP_CARDS_DIR = path.join(TEST_ROOT, 'cards');
  const TMP_CHATS_DIR = path.join(TMP_CARDS_DIR, 'chats');
  const ECHO_HANDLER_PATH = mode.echoHandlerExt === 'mjs'
    ? path.join(TEST_ROOT, 'echo-chat-handler.mjs')
    : path.join(TEST_ROOT, 'echo-chat-handler.py');
  const API_BASE = `http://127.0.0.1:${TEST_PORT}/api/boards/default`;

  let serverProc: ChildProcess | null = null;
  let serverLogs = '';

  function createFixtures() {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(SETUP_DIR, { recursive: true });
    fs.mkdirSync(TMP_CARDS_DIR, { recursive: true });

    // Write echo chat-handler
    const src = mode.echoHandlerExt === 'mjs' ? ECHO_HANDLER_NODE_SRC : ECHO_HANDLER_PYTHON_SRC;
    fs.writeFileSync(ECHO_HANDLER_PATH, src, 'utf-8');

    // Copy card JSON files
    for (const entry of fs.readdirSync(SOURCE_CARDS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        fs.copyFileSync(path.join(SOURCE_CARDS_DIR, entry.name), path.join(TMP_CARDS_DIR, entry.name));
      }
    }
  }

  async function waitForServerReady(): Promise<void> {
    const url = `http://127.0.0.1:${TEST_PORT}/api/boards`;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        if (res.ok || res.status === 404) return;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const logTail = serverLogs.slice(-3000);
    throw new Error(`Server [${mode.label}] did not become ready.\nLogs:\n${logTail}`);
  }

  beforeAll(async () => {
    createFixtures();

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      DEMO_SERVER_PORT: String(TEST_PORT),
      DEMO_SETUP_DIR: SETUP_DIR,
      DEMO_CARDS_DIR: TMP_CARDS_DIR,
      DEMO_CHAT_HANDLER_PATH: ECHO_HANDLER_PATH,
    };

    // For the Node server, also set task executor
    if (mode.echoHandlerExt === 'mjs') {
      env.DEMO_TASK_EXECUTOR_PATH = path.join(exampleBoardDir, 'demo-task-executor.js');
    }

    serverProc = spawn(mode.cmd, mode.args, {
      cwd: exampleBoardDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverLogs = '';
    serverProc.stdout?.on('data', (d) => { serverLogs += String(d); });
    serverProc.stderr?.on('data', (d) => { serverLogs += String(d); });
    serverProc.on('error', (err) => { serverLogs += `\n[SPAWN ERROR] ${err.message}\n`; });

    await waitForServerReady();

    // Register default board
    await fetch(`${API_BASE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'default' }),
    });

    // Run demo-setup
    const setupRes = await fetch(`${API_BASE}/demo-setup`);
    if (!setupRes.ok) {
      const body = await setupRes.text();
      throw new Error(`demo-setup failed [${mode.label}]: ${setupRes.status} ${body}`);
    }
  }, 30000);

  afterAll(async () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      // On Windows, SIGTERM may not work for Python
      if (process.platform === 'win32') {
        try { process.kill(serverProc.pid!, 'SIGKILL'); } catch { /* ok */ }
      }
      serverProc = null;
    }
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── Helper functions ────────────────────────────────────────────────────

  async function getBootstrapPayload(): Promise<Record<string, unknown>> {
    const boot = await fetch(`${API_BASE}/bootstrap`);
    expect(boot.ok, `bootstrap failed: ${boot.status}`).toBe(true);
    return await boot.json() as Record<string, unknown>;
  }

  async function getCardFromBootstrap(cardId: string): Promise<Record<string, unknown>> {
    const payload = await getBootstrapPayload();
    const cards = Array.isArray(payload.cardDefinitions) ? payload.cardDefinitions : [];
    const card = cards.find((c: any) => c && c.id === cardId);
    expect(card, `card ${cardId} not found in bootstrap`).toBeTruthy();
    return card as Record<string, unknown>;
  }

  async function uploadFile(cardId: string, fileName: string, content: string, contentType = 'text/plain') {
    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/files`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-file-name': encodeURIComponent(fileName),
      },
      body: Buffer.from(content, 'utf8'),
    });
    expect(res.ok, `upload failed: ${res.status} ${await res.clone().text()}`).toBe(true);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);
    return payload.file;
  }

  async function sendChatMessage(cardId: string, userMessage: string): Promise<void> {
    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionType: 'chat-send', payload: { user: 'test-user', text: userMessage } }),
    });
    expect(res.ok, `chat-send failed: ${res.status}`).toBe(true);
  }

  async function readSseDataEvents(url: string, expectedCount: number, timeoutMs: number): Promise<string[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const events: string[] = [];
    try {
      const res = await fetch(url, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      expect(res.ok).toBe(true);
      const reader = res.body?.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (events.length < expectedCount) {
        const next = await reader!.read();
        if (next.done) break;
        buf += decoder.decode(next.value, { stream: true });
        while (true) {
          const idx = buf.indexOf('\n');
          if (idx < 0) break;
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trim();
          if (payload) events.push(payload);
          if (events.length >= expectedCount) break;
        }
      }
    } catch { /* timeout/abort expected */ } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    return events;
  }

  // ── Tests ───────────────────────────────────────────────────────────────

  it('GET /api/boards returns boards list', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/boards`);
    expect(res.ok).toBe(true);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.boards)).toBe(true);
    expect(payload.boards.length).toBeGreaterThan(0);
    expect(payload.boards[0].id).toBe('default');
  });

  it('GET bootstrap returns cardDefinitions and cardRuntimeById', async () => {
    const payload = await getBootstrapPayload();
    expect(Array.isArray(payload.cardDefinitions)).toBe(true);
    expect((payload.cardDefinitions as any[]).length).toBeGreaterThan(0);
    expect(typeof payload.cardRuntimeById).toBe('object');
    expect(payload.cardRuntimeById).not.toBeNull();
  });

  it('GET board-status returns ok', async () => {
    const res = await fetch(`${API_BASE}/board-status`);
    expect(res.ok).toBe(true);
    const payload = await res.json() as any;
    expect(payload.boardId).toBe('default');
  });

  it('PATCH card updates card_data and returns updated card', async () => {
    const cardId = 'card-portfolio';
    const patchBody = { card_data: { custom_field: 'patched-value' } };
    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    expect(res.ok).toBe(true);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);

    // Verify via bootstrap
    const card = await getCardFromBootstrap(cardId);
    const cardData = card.card_data as Record<string, unknown> | undefined;
    expect(cardData?.custom_field).toBe('patched-value');
  });

  it('POST file upload and GET download round-trip', async () => {
    const cardId = 'card-portfolio';
    const content = 'dual-test-file-content';
    const fileName = 'dual-test.txt';
    const uploaded = await uploadFile(cardId, fileName, content);

    expect(uploaded.name).toBe(fileName);
    expect(uploaded.size).toBe(Buffer.byteLength(content, 'utf8'));
    expect(uploaded.stored_name).toMatch(/^\d{3}-[a-z0-9._-]+$/);

    // Add file to card
    await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionType: 'file-upload', payload: { files: [uploaded] } }),
    });

    // Find the file index in card
    const card = await getCardFromBootstrap(cardId);
    const files = ((card.card_data as any)?.files ?? []) as any[];
    const idx = files.findIndex((f: any) => f?.stored_name === uploaded.stored_name);
    expect(idx).toBeGreaterThanOrEqual(0);

    // Download
    const dlRes = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/files/${idx}?sn=${encodeURIComponent(uploaded.stored_name)}`);
    expect(dlRes.ok).toBe(true);
    expect(await dlRes.text()).toBe(content);
  }, 20000);

  it('POST chat-send persists user message', async () => {
    const cardId = 'card-portfolio';
    await sendChatMessage(cardId, 'dual-parity-test-message');

    // Read chats API
    const chatRes = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/chats`);
    expect(chatRes.ok).toBe(true);
    const chatPayload = await chatRes.json() as any;
    const messages = Array.isArray(chatPayload.messages) ? chatPayload.messages : [];
    expect(messages.length).toBeGreaterThan(0);
    const found = messages.find((m: any) => m?.text?.includes?.('dual-parity-test-message'));
    expect(found).toBeTruthy();
  }, 20000);

  it('SSE stream emits at least one data frame on connect', async () => {
    const events = await readSseDataEvents(`${API_BASE}/sse`, 1, 8000);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(events[0]);
    expect(first.cardDefinitions).toBeTruthy();
  }, 15000);

  it('chat-handler invocation produces assistant reply', async () => {
    const cardId = 'card-portfolio';
    const testMsg = 'hello from chat-handler test (dual)';

    // Get baseline chat signal count via bootstrap
    const beforePayload = await getBootstrapPayload();
    const beforeRuntime = (beforePayload.cardRuntimeById as any)?.[cardId];
    const beforeCount = beforeRuntime?.card_data?.__chat_signal?.count ?? 0;

    await sendChatMessage(cardId, testMsg);

    // Poll for the chat signal count to increase (the handler writes a file
    // to the chats directory, which is picked up by the signal scan even though
    // it doesn't update the index)
    const deadline = Date.now() + 12000;
    let countIncreased = false;
    while (Date.now() < deadline) {
      const payload = await getBootstrapPayload();
      const runtime = (payload.cardRuntimeById as any)?.[cardId];
      const currentCount = runtime?.card_data?.__chat_signal?.count ?? 0;
      // The user message itself adds 1, and the handler reply adds another 1
      if (currentCount >= beforeCount + 2) {
        countIncreased = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(countIncreased, 'Expected chat-handler to produce a reply file (signal count should increase by 2)').toBe(true);
  }, 20000);
});
