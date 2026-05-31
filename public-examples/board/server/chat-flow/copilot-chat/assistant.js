#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJsonStdin } from './shared.js';

const HANDLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_BAT = path.join(HANDLER_DIR, 'copilot_wrapper.bat');
const DBG_LOG = path.join(HANDLER_DIR, 'assistant-debug.log');
const DBG_ENABLED = String(process.env.YAML_FLOW_CHAT_DEBUG || '').toLowerCase() === 'true';

const dbg = DBG_ENABLED
  ? (msg) => {
      try {
        fs.appendFileSync(DBG_LOG, `[assistant.DBG ${new Date().toISOString()} pid=${process.pid}] ${msg}\n`);
      } catch {}
    }
  : () => {};

dbg('startup: reading JSON stdin');
const extra = readJsonStdin();
dbg(`startup: stdin parsed (keys=${Object.keys(extra || {}).join(',')})`);
const {
  cardId = '',
  boardSetupRoot = '',
  boardRuntimeDir = '',
  runtimeStatusDir = '',
  cardsDir = '',
  chatMessages: rawChatMessages = [],
  userText = 'what is two plus two?',
  turnId = '',
  chatCopilotTimeoutMs: rawChatCopilotTimeoutMs = 300000,
} = extra;

const chatMessages = Array.isArray(rawChatMessages) ? rawChatMessages : [];
const chatCopilotTimeoutMs = Number.isFinite(Number(rawChatCopilotTimeoutMs)) && Number(rawChatCopilotTimeoutMs) > 0
  ? Math.floor(Number(rawChatCopilotTimeoutMs))
  : 300000;


function buildPrompt(cId, historyDump, currentUserText, currentTurnId) {
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
    ...(currentTurnId ? ['The current conversation turn id is: ' + currentTurnId] : []),
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
  dbg(`runCopilot: writing prompt (${prompt.length} chars) to ${promptFile}`);
  fs.writeFileSync(promptFile, prompt, 'utf-8');
  try {
    dbg(`runCopilot: spawning wrapper ${WRAPPER_BAT} (timeout=${chatCopilotTimeoutMs}ms, cwd=${workingDir || process.cwd()})`);
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
    const hasOut = fs.existsSync(outFile);
    const out = hasOut ? fs.readFileSync(outFile, 'utf-8').trim() : '';
    dbg(`runCopilot: wrapper returned (outFileExists=${hasOut}, replyLen=${out.length})`);
    dbg(`runCopilot: reply snippet: ${JSON.stringify(out.slice(0, 400))}`);
    return out;
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

const historyDump = JSON.stringify(chatMessages, null, 2);
const workingDir = boardSetupRoot;
dbg(`main: cardId=${cardId} turnId=${turnId} userTextLen=${String(userText).length} history=${chatMessages.length} workingDir=${workingDir}`);
const prompt = buildPrompt(cardId, historyDump, userText.trim(), String(turnId || '').trim());
dbg(`main: prompt built (${prompt.length} chars)`);

try {
  const replyText = runCopilot(prompt, workingDir).trim();
  dbg(`main: runCopilot returned replyLen=${replyText.length}`);
  if (!replyText) {
    dbg('main: empty reply, throwing');
    throw new Error('Copilot returned an empty response');
  }
  process.stdout.write(JSON.stringify({ replyText }));
  dbg('main: reply written to stdout, exiting 0');
} catch (err) {
  dbg(`main: error caught: ${err?.message ?? String(err)}`);
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}
