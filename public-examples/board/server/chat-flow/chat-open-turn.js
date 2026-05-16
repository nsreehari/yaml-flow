#!/usr/bin/env node

import fs from 'node:fs';

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

function parseBoolean(value, fallback = false) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parsePositiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseChatEnvelope(raw) {
  // Chat payload supports either plain text or a JSON envelope.
  // JSON fields: prompt|text|userText|query, probe, chatTimeoutMs|chatCopilotTimeoutMs, chatTimeMs.
  if (!raw) {
    return {
      userText: '',
      probe: false,
      chatHandlerMode: 'copilot',
      chatCopilotTimeoutMs: null,
      chatTimeMs: null,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not-an-object');
    }
    const prompt = [parsed.prompt, parsed.text, parsed.userText, parsed.query]
      .find((value) => typeof value === 'string' && value.trim().length > 0);
    const probe = parseBoolean(parsed.probe, false);
    const modeFromInput = typeof parsed.chatHandlerMode === 'string' ? parsed.chatHandlerMode.trim().toLowerCase() : '';
    return {
      userText: (typeof prompt === 'string' ? prompt : raw).trim(),
      probe,
      chatHandlerMode: modeFromInput || (probe ? 'probe' : 'copilot'),
      chatCopilotTimeoutMs: parsePositiveInt(parsed.chatTimeoutMs ?? parsed.chatCopilotTimeoutMs, null),
      chatTimeMs: parsePositiveInt(parsed.chatTimeMs, null),
    };
  } catch {
    return {
      userText: raw.trim(),
      probe: false,
      chatHandlerMode: 'copilot',
      chatCopilotTimeoutMs: null,
      chatTimeMs: null,
    };
  }
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

if (!cardId || !serverUrl || !apiBasePath || !lastChatEntryId) {
  process.stderr.write('chat-open-turn requires cardId, serverUrl, apiBasePath, and lastChatEntryId\n');
  process.exit(1);
}

let messageText = '';
try {
  const chatsUrl = `${serverUrl}${apiBasePath}/cards/${encodeURIComponent(cardId)}/chats`;
  const res = await fetch(chatsUrl);
  if (!res.ok) {
    process.stderr.write(`chat-open-turn could not fetch chat history: HTTP ${res.status}\n`);
    process.exit(1);
  }
  const data = await res.json();
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const currentUser = messages.find((message) =>
    typeof message?.id === 'string'
    && message.id === lastChatEntryId
    && message.role === 'user'
  );
  messageText = typeof currentUser?.text === 'string' ? currentUser.text : '';
} catch (err) {
  process.stderr.write(`chat-open-turn could not fetch current user turn: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

if (!messageText) {
  process.stderr.write('chat-open-turn could not resolve user text for lastChatEntryId\n');
  process.exit(1);
}

const envelope = parseChatEnvelope(messageText);
const userText = envelope.userText;
const probe = envelope.probe;
const chatHandlerMode = envelope.chatHandlerMode;
const chatCopilotTimeoutMs = envelope.chatCopilotTimeoutMs
  ?? (Number.isFinite(Number(extra.chatCopilotTimeoutMs)) && Number(extra.chatCopilotTimeoutMs) > 0
    ? Math.floor(Number(extra.chatCopilotTimeoutMs))
    : 300000);
const chatTimeMs = envelope.chatTimeMs;

process.stdout.write(JSON.stringify({
  boardId,
  cardId,
  boardSetupRoot,
  boardRuntimeDir,
  runtimeStatusDir,
  cardsDir,
  projectRoot,
  chatFlowRoot,
  userText,
  serverUrl,
  apiBasePath,
  lastChatEntryId,
  probe,
  chatHandlerMode,
  chatCopilotTimeoutMs,
  chatTimeMs,
}));
