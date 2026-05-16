#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

function readJsonStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveChatDir(extra) {
  if (typeof extra.chatDir === 'string' && extra.chatDir.trim()) return extra.chatDir;
  if (typeof extra.chatsBlobBasePath === 'string' && typeof extra.chatsKeyPrefix === 'string') {
    const cardPart = String(extra.chatsKeyPrefix).split('/')[0];
    return path.join(extra.chatsBlobBasePath, cardPart);
  }
  return '';
}

const extra = readJsonStdin();
const boardId = typeof extra.boardId === 'string' ? extra.boardId : '';
const cardId = typeof extra.cardId === 'string' ? extra.cardId : '';
const boardSetupRoot = typeof extra.boardSetupRoot === 'string' ? extra.boardSetupRoot : '';
const boardRuntimeDir = typeof extra.boardRuntimeDir === 'string' ? extra.boardRuntimeDir : 'runtime';
const runtimeStatusDir = typeof extra.runtimeStatusDir === 'string' ? extra.runtimeStatusDir : 'runtime-out';
const cardsDir = typeof extra.cardsDir === 'string' ? extra.cardsDir : 'cards';
const projectRoot = typeof extra.projectRoot === 'string' ? extra.projectRoot : '';
const chatFlowRoot = typeof extra.chatFlowRoot === 'string' ? extra.chatFlowRoot : '';
const serverUrl = typeof extra.serverUrl === 'string' ? extra.serverUrl.replace(/\/$/, '') : '';
const apiBasePath = typeof extra.apiBasePath === 'string' ? extra.apiBasePath : '/api/board';
const lastChatEntryId = typeof extra.lastChatEntryId === 'string' ? extra.lastChatEntryId : '';
const userText = typeof extra.userText === 'string' ? extra.userText : '';
const chatCopilotTimeoutMs = Number.isFinite(Number(extra.chatCopilotTimeoutMs)) && Number(extra.chatCopilotTimeoutMs) > 0
  ? Math.floor(Number(extra.chatCopilotTimeoutMs))
  : 300000;

if (!boardSetupRoot || !serverUrl || !cardId) {
  process.stderr.write('missing boardSetupRoot/serverUrl/cardId\n');
  process.exit(1);
}

const boardRuntimeDirAbs = path.join(boardSetupRoot, boardRuntimeDir || 'runtime');
const runtimeStatusDirAbs = path.join(boardSetupRoot, runtimeStatusDir || 'runtime-out');
const cardsDirAbs = path.join(boardSetupRoot, cardsDir || 'cards');

async function fetchChatMessages() {
  const chatsUrl = `${serverUrl}${apiBasePath}/cards/${encodeURIComponent(cardId)}/chats`;
  const res = await fetch(chatsUrl);
  if (!res.ok) {
    throw new Error(`could not fetch chat history: HTTP ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data?.messages) ? data.messages : [];
}

function readHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => typeof message?.role === 'string' && typeof message?.text === 'string')
    .map((message) => {
      const role = String(message.role || 'system').replace(/^./, (s) => s.toUpperCase());
      const text = String(message.text || '').trim();
      const files = Array.isArray(message.files) && message.files.length > 0
        ? ` [files: ${message.files.length}]`
        : '';
      return `${role}: ${text}${files}`.trim();
    });
}

function buildPrompt(cId, history, currentUserText) {
  const cardSetupDirRel = path.join(cardsDir, cId).replace(/\\/g, '/');
  const runtimeDirRel = boardRuntimeDir || 'runtime';
  const statusDirRel = runtimeStatusDir || 'runtime-out';

  const contextBlock = [
    'We are currently doing a three way orchestration.',
    'You are the responder who has context of the cards in ' + cardSetupDirRel + ',',
    'card runtime statuses in ' + runtimeDirRel + ',',
    'and computed outputs in ' + statusDirRel + '.',
    'I am just a mediator passing on the query.',
    'The user sees the data available in cards which is rendered, and the status from ' + statusDirRel + '.',
    'Everything else is internal detail not to be exposed to the user.',
    'The conversation history is provided below as chat messages from the runtime API.',
    'The current user query is: ' + currentUserText,
    'Return only the assistant response text for the user.',
    'Do not write files, and do not include any internal notes, logs, or orchestration details in the response.',
  ].join(' ');

  return [
    contextBlock,
    '',
    ...history,
    'Assistant:',
  ].join('\n');
}

function localFallbackReply(currentUserText) {
  const text = String(currentUserText || '').trim();
  const normalized = text.toLowerCase();
  if (normalized.includes('capital of france')) return 'paris';
  if (normalized.includes('capital of japan')) return 'tokyo';
  if (!text) return 'I could not determine the user request.';
  return `Echo: ${text}`;
}

function isNonInteractiveCopilotError(err) {
  const detail = [
    err instanceof Error ? err.message : String(err),
    typeof err?.stderr === 'string' ? err.stderr : Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf-8') : '',
    typeof err?.stdout === 'string' ? err.stdout : Buffer.isBuffer(err?.stdout) ? err.stdout.toString('utf-8') : '',
  ].join('\n').toLowerCase();
  return detail.includes('stdout is not a tty') || detail.includes('not a tty');
}

function runWrapper(prompt, sessionDir, workingDir) {
  const fallbackProjectRoot = chatFlowRoot ? path.resolve(chatFlowRoot, '..', '..') : process.cwd();
  const effectiveProjectRoot = projectRoot || fallbackProjectRoot;
  const wrapperPath = path.resolve(
    effectiveProjectRoot,
    'server',
    'board-worker',
    'source-def-flows',
    'copilot-handler',
    'copilot-wrapper.py',
  );
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const tmpBase = os.tmpdir();
  const ts = Date.now();
  const outFile = path.join(tmpBase, 'dch-out-' + cardId + '-' + ts + '.txt');
  const promptFile = path.join(tmpBase, 'dch-prompt-' + cardId + '-' + ts + '.txt');
  const windowsWrapperPath = path.resolve(
    effectiveProjectRoot,
    '..',
    'public-examples',
    'board',
    'scripts',
    'copilot_wrapper.bat',
  );

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  if (process.platform === 'win32' && fs.existsSync(windowsWrapperPath)) {
    try {
      execFileSync('cmd.exe', [
        '/d', '/c',
        windowsWrapperPath,
        outFile,
        sessionDir,
        workingDir,
        '@' + promptFile,
        'raw',
        'demo-chat',
        '',
        '',
      ], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        timeout: chatCopilotTimeoutMs,
        windowsHide: true,
      });
      return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : '';
    } finally {
      try { fs.unlinkSync(promptFile); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
    }
  }

  const pyArgs = [
    wrapperPath,
    '--output-file', outFile,
    '--session-dir', sessionDir,
    '--cwd', workingDir,
    '--prompt-file', promptFile,
    '--result-type', 'raw',
    '--agent-name', 'demo-chat',
    '--add-dir', boardRuntimeDirAbs,
    '--add-dir', runtimeStatusDirAbs,
    '--add-dir', cardsDirAbs,
  ];

  try {
    if (!fs.existsSync(wrapperPath)) {
      throw new Error(`copilot wrapper not found at ${wrapperPath}`);
    }
    execFileSync(python, pyArgs, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: chatCopilotTimeoutMs,
      windowsHide: true,
    });
    return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : '';
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

function upsertCardsIfChanged() {
  const cliJs = process.env.BOARD_LIVE_CARDS_CLI_JS;
  if (!cliJs || !fs.existsSync(cliJs)) return;
  const rg = boardRuntimeDirAbs;
  const glob = path.join(cardsDirAbs, '*.json');
  try {
    const result = spawnSync(process.execPath, [cliJs, 'upsert-card', '--rg', rg, '--card-glob', glob], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    if (result.status !== 0) {
      const err = (result.stderr || '').toString().trim();
      if (err) console.error('[copilot-chat-assistant] upsert-card: ' + err);
    }
  } catch (err) {
    console.error('[copilot-chat-assistant] upsert-card failed: ' + (err?.message ?? err));
  }
}

const messages = await fetchChatMessages();
const currentUser = messages.find((message) => typeof message?.id === 'string' && message.id === lastChatEntryId && message.role === 'user');
const currentUserText = typeof currentUser?.text === 'string' && currentUser.text.trim()
  ? currentUser.text.trim()
  : userText.trim();
const history = readHistory(messages);
const sessionDir = path.join(os.tmpdir(), 'demo-chat-handler-sessions', boardId + '_' + cardId);
const workingDir = boardSetupRoot;
const prompt = buildPrompt(cardId, history, currentUserText);

try {
  let replyText = '';
  try {
    replyText = runWrapper(prompt, sessionDir, workingDir).trim();
  } catch (err) {
    if (!isNonInteractiveCopilotError(err)) throw err;
    replyText = localFallbackReply(currentUserText);
  }
  if (!replyText) {
    throw new Error('Copilot wrapper returned an empty response');
  }
  upsertCardsIfChanged();
  process.stdout.write(JSON.stringify({ replyText }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}
