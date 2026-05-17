#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HANDLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_BAT = path.join(HANDLER_DIR, 'copilot_wrapper.bat');

function readJsonStdin() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const extra = readJsonStdin();
const {
  cardId = '',
  boardSetupRoot = '',
  boardRuntimeDir = '',
  runtimeStatusDir = '',
  cardsDir = '',
  chatMessages: rawChatMessages = [],
  userText = 'what is two plus two?',
  chatCopilotTimeoutMs: rawChatCopilotTimeoutMs = 300000,
} = extra;

const chatMessages = Array.isArray(rawChatMessages) ? rawChatMessages : [];
const chatCopilotTimeoutMs = Number.isFinite(Number(rawChatCopilotTimeoutMs)) && Number(rawChatCopilotTimeoutMs) > 0
  ? Math.floor(Number(rawChatCopilotTimeoutMs))
  : 300000;


function buildPrompt(cId, historyDump, currentUserText) {
  const cardSetupDirRel = path.join(cardsDir, cId).replace(/\\/g, '/');
  const runtimeDirRel = boardRuntimeDir;
  const statusDirRel = runtimeStatusDir;

  const contextBlock = [
    'We are currently doing a three way orchestration.',
    'You are the responder who has context of the cards in ' + cardSetupDirRel + ',',
    'card runtime statuses in ' + runtimeDirRel + ',',
    'and computed outputs in ' + statusDirRel + '.',
    'I am just a mediator passing on the query.',
    'The user sees the data available in cards which is rendered, and the status from ' + statusDirRel + '.',
    'Everything else is internal detail not to be exposed to the user.',
    'The conversation history is provided below exactly as received from the runtime API as a string dump.',
    'The current user query is: ' + currentUserText,
    'Return only the assistant response text for the user.',
    'Do not write files, and do not include any internal notes, logs, or orchestration details in the response.',
  ].join(' ');

  return [
    contextBlock,
    '',
    'Chat history dump:',
    historyDump,
    '',
    'Assistant response:',
  ].join('\n');
}

function runCopilot(prompt, workingDir) {
  const ts = Date.now();
  const promptFile = path.join(os.tmpdir(), `asst-prompt-${ts}.txt`);
  const outFile = path.join(os.tmpdir(), `asst-out-${ts}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf-8');
  try {
    execFileSync('cmd.exe', [
      '/d', '/c', WRAPPER_BAT,
      outFile,
      os.tmpdir(),
      workingDir || process.cwd(),
      '@' + promptFile,
      'raw',
      'demo-chat',
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

const historyDump = JSON.stringify(chatMessages, null, 2);
const workingDir = boardSetupRoot;
const prompt = buildPrompt(cardId, historyDump, userText.trim());

try {
  const replyText = runCopilot(prompt, workingDir).trim();
  if (!replyText) {
    throw new Error('Copilot returned an empty response');
  }
  process.stdout.write(JSON.stringify({ replyText }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}
