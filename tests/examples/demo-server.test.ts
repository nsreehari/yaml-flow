import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const demoServerPath = path.join(repoRoot, 'examples', 'example-board', 'demo-server.js');

const TEST_PORT = 7800 + Math.floor(Math.random() * 100); // Use random port to avoid conflicts
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-demo-server-fileapi-'));
const SURFACE_DIR = path.join(TEST_ROOT, 'surface');
const BOARD_DIR = path.join(TEST_ROOT, 'board');
const RUNTIME_OUT_DIR = path.join(TEST_ROOT, 'runtime-out');
const TMP_CARDS_DIR = path.join(SURFACE_DIR, 'tmp-cards');
const API_BASE = `http://127.0.0.1:${TEST_PORT}/api/example-board/server`;

let serverProc: ChildProcess | null = null;
let serverLogs = '';

function createMinimalFixtureDirs() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // Create minimal directory structure; demo-server will populate these
  fs.mkdirSync(SURFACE_DIR, { recursive: true });
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_OUT_DIR, { recursive: true });
}

async function waitForServerReady(): Promise<void> {
  const url = `http://127.0.0.1:${TEST_PORT}/__ready-check__`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      // Server is up once it responds (404 is expected for this path).
      if (res.status === 404 || res.ok) return;
    } catch {
      // Retry until server comes up.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('demo-server did not become ready in time');
}

beforeAll(async () => {
  createMinimalFixtureDirs();

  serverProc = spawn(process.execPath, [demoServerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DEMO_SERVER_PORT: String(TEST_PORT),
      DEMO_SURFACE_DIR: SURFACE_DIR,
      DEMO_BOARD_RUNTIME_DIR: BOARD_DIR,
      DEMO_RUNTIME_OUT_DIR: RUNTIME_OUT_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverLogs = '';
  serverProc.stdout?.on('data', (d) => {
    serverLogs += String(d);
  });
  serverProc.stderr?.on('data', (d) => {
    serverLogs += String(d);
  });

  await waitForServerReady();
});

afterAll(async () => {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    serverProc = null;
  }
  // Give process time to fully exit and release file handles (especially on Windows)
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors in afterAll
  }
});

async function uploadFile(cardId: string, fileName: string, content: string, contentType = 'text/plain') {
  let upload: Response;
  try {
    upload = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/files`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-file-name': encodeURIComponent(fileName),
      },
      body: Buffer.from(content, 'utf8'),
    });
  } catch (err) {
    const logTail = serverLogs.slice(-2000);
    throw new Error(`upload request failed: ${String(err)}\nserver logs:\n${logTail}`);
  }
  expect(upload.ok).toBe(true);
  const payload = await upload.json() as {
    ok: boolean;
    file: {
      name: string;
      stored_name: string;
      size: number;
      mime_type: string;
      path: string;
      uploaded_at: string;
    };
  };
  expect(payload.ok).toBe(true);
  return payload.file;
}

async function addUploadedFileToCard(cardId: string, fileMeta: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionType: 'file-upload', payload: { files: [fileMeta] } }),
  });
  expect(res.ok).toBe(true);
}

async function getCardFromBootstrap(cardId: string): Promise<Record<string, unknown>> {
  const boot = await fetch(`${API_BASE}/bootstrap`);
  expect(boot.ok).toBe(true);
  const payload = await boot.json() as { cardDefinitions?: Array<Record<string, unknown>> };
  const cards = Array.isArray(payload.cardDefinitions) ? payload.cardDefinitions : [];
  const card = cards.find((entry) => entry && entry.id === cardId);
  expect(card).toBeTruthy();
  return card as Record<string, unknown>;
}

function getCardFiles(card: Record<string, unknown>) {
  const cardData = card.card_data as Record<string, unknown> | undefined;
  return Array.isArray(cardData?.files) ? cardData.files as Array<Record<string, unknown>> : [];
}

function getCardChats(card: Record<string, unknown>) {
  const cardData = card.card_data as Record<string, unknown> | undefined;
  return Array.isArray(cardData?.chats) ? cardData.chats as Array<Record<string, unknown>> : [];
}

async function sendChatMessage(cardId: string, userMessage: string): Promise<void> {
  const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionType: 'chat-send', payload: { user: 'test-user', text: userMessage } }),
  });
  expect(res.ok).toBe(true);
}

function getCardChatsDir(cardId: string): string {
  return path.join(TMP_CARDS_DIR, cardId, 'chats');
}

function readChatFileNames(cardId: string): string[] {
  const chatsDir = getCardChatsDir(cardId);
  if (!fs.existsSync(chatsDir)) return [];
  return fs.readdirSync(chatsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

describe('demo-server file upload + card list + download', () => {
  const cardId = 'card-ex-file-upload';

  it('uploads file, updates card file list, and downloads via card entry lookup', async () => {
    const originalText = 'hello-download-flow';
    const uploaded = await uploadFile(cardId, 'my report final.txt', originalText, 'text/plain');

    expect(uploaded.name).toBe('my report final.txt');
    expect(uploaded.size).toBe(Buffer.byteLength(originalText, 'utf8'));
    expect(uploaded.mime_type).toBe('text/plain');
    expect(uploaded.path).toContain(`${cardId}/files/`);
    expect(uploaded.stored_name).toMatch(/^\d{3}-[a-z0-9._-]+$/);
    expect(uploaded.stored_name.length).toBeLessThanOrEqual(32);

    await addUploadedFileToCard(cardId, uploaded);

    const card = await getCardFromBootstrap(cardId);
    const files = getCardFiles(card);
    expect(files.length).toBeGreaterThan(0);

    const idx = files.findIndex((f) => f && f.stored_name === uploaded.stored_name);
    expect(idx).toBeGreaterThanOrEqual(0);

    const fromCard = files[idx];
    expect(fromCard?.name).toBe(uploaded.name);
    expect(fromCard?.mime_type).toBe(uploaded.mime_type);

    const download = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/files/${idx}?sn=${encodeURIComponent(uploaded.stored_name)}`);
    expect(download.ok).toBe(true);
    expect(download.headers.get('content-type')).toBe('text/plain');
    expect(download.headers.get('content-disposition') || '').toContain(`filename="${uploaded.name}"`);
    expect(await download.text()).toBe(originalText);

    const stale = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/files/${idx}?sn=999-wrong.txt`);
    expect(stale.status).toBe(409);
  }, 30000);

  it('sends chat message and persists it to card chat files (not card_data)', async () => {
    const chatCardId = 'card-ex-chat';
    const testMessage = 'Hello from test user';

    const before = readChatFileNames(chatCardId);

    await sendChatMessage(chatCardId, testMessage);

    const afterFirst = readChatFileNames(chatCardId);
    expect(afterFirst.length).toBe(before.length + 1);

    const firstNew = afterFirst.find((name) => !before.includes(name));
    expect(firstNew).toBeTruthy();
    expect(firstNew || '').toMatch(/^\d{3}_(system|user|assistant)\.txt$/);

    const firstPath = path.join(getCardChatsDir(chatCardId), firstNew as string);
    expect(fs.readFileSync(firstPath, 'utf8')).toContain(testMessage);

    const card = await getCardFromBootstrap(chatCardId);
    expect(getCardChats(card).length).toBe(0);

    const secondMessage = 'Follow-up message';
    await sendChatMessage(chatCardId, secondMessage);

    const afterSecond = readChatFileNames(chatCardId);
    expect(afterSecond.length).toBe(afterFirst.length + 1);

    const secondNew = afterSecond.find((name) => !afterFirst.includes(name));
    expect(secondNew).toBeTruthy();
    expect(secondNew || '').toMatch(/^\d{3}_(system|user|assistant)\.txt$/);

    const secondPath = path.join(getCardChatsDir(chatCardId), secondNew as string);
    expect(fs.readFileSync(secondPath, 'utf8')).toContain(secondMessage);
  }, 30000);
});
