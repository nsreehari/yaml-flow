#!/usr/bin/env node
/**
 * demo-chat-handler.js — LLM-based chat handler for example-board.
 *
 * Protocol (invoked by reusable-server-runtime after a user message is persisted):
 *   node demo-chat-handler.js --boardId <id> --cardId <id> --extraEncJson <base64json>
 *
 * --extraEncJson decodes to: { chatDir: "<abs>", boardDir: "<abs>", lastChatFile: "<filename>" }
 *
 * Design:
 *   The chat handler is universal — it does not depend on any source definition or card model.
 *   It reads the full conversation history from chatDir, builds a grounded system prompt
 *   (scoped to the card and board), and calls the LLM directly (Copilot CLI).
 *   Copilot is invoked from boardDir (cwd), so it naturally has access to board files.
 *
 *   The LLM is the sole decision-maker. No rule-based fallback is used here — if the LLM
 *   is unavailable, the handler writes a short error acknowledgment so the user isn't left
 *   with a silent failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : null;
}

const boardId  = getArg('--boardId') || '';
const cardId   = getArg('--cardId') || '';
const extraStr = getArg('--extraEncJson') || '';

let extra = {};
try {
  extra = JSON.parse(Buffer.from(extraStr, 'base64').toString('utf-8'));
} catch {
  console.error('[demo-chat-handler] could not parse --extraEncJson');
  process.exit(0);
}

const { chatDir, boardDir, lastChatFile } = extra;

if (!chatDir || !lastChatFile) {
  console.error('[demo-chat-handler] --extraEncJson must contain chatDir and lastChatFile');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Read full conversation history from chatDir (all user + assistant turns)
// ---------------------------------------------------------------------------
function readConversationHistory(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => /^\d+[-_](user|assistant)\.txt$/i.test(f));
    files.sort();
  } catch {
    return [];
  }
  return files.map(f => {
    const role = /user/i.test(f) ? 'User' : 'Assistant';
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf-8').trim(); } catch {}
    return `${role}: ${text}`;
  });
}

// ---------------------------------------------------------------------------
// Build prompt: system instruction + conversation turns
// ---------------------------------------------------------------------------
function buildPrompt(bId, cId, history) {
  return [
    `You are a helpful assistant embedded in a live data card (card: "${cId}", board: "${bId}").`,
    'Help the user understand and act on the data shown in this card.',
    'Be concise — this is an inline card chat, not a full conversation window.',
    'Ground answers in the card\'s data context. Ask one short question if the intent is ambiguous.',
    '',
    ...history,
    'Assistant:',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Call Copilot CLI — same pattern as demo-task-executor.js
// ---------------------------------------------------------------------------
function stripCopilotFooter(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (
    lines.length >= 3 &&
    /^Changes\b/i.test(lines[lines.length - 3]) &&
    /^Requests\b/i.test(lines[lines.length - 2]) &&
    /^Tokens\b/i.test(lines[lines.length - 1])
  ) {
    lines.splice(lines.length - 3, 3);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function resolveCopilotExecutable() {
  const envBin = process.env.COPILOT_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['copilot'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const candidates = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return candidates.find(p => /\.(cmd|exe|bat)$/i.test(p)) ?? candidates[0] ?? 'copilot';
    } catch {}
  } else {
    try {
      const out = execFileSync('which', ['copilot'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? 'copilot';
    } catch {}
  }
  return 'copilot';
}

function runCopilotPrompt(prompt, cwd) {
  const copilotBin = resolveCopilotExecutable();
  const opts = {
    input: String(prompt),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60000,
    ...(cwd ? { cwd } : {}),
  };
  try {
    return execFileSync(copilotBin, ['--allow-all'], opts);
  } catch (directErr) {
    if (process.platform === 'win32') {
      try {
        return execFileSync('cmd.exe', ['/d', '/c', 'copilot --allow-all'], opts);
      } catch (cmdErr) {
        const msg = [
          directErr?.stderr?.trim?.(),
          cmdErr?.stderr?.trim?.(),
          String(cmdErr?.message ?? cmdErr),
        ].filter(Boolean).join(' | ');
        throw new Error(msg || 'copilot invocation failed');
      }
    }
    const msg = [directErr?.stderr?.trim?.(), String(directErr?.message ?? directErr)].filter(Boolean).join(' | ');
    throw new Error(msg || 'copilot invocation failed');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const history  = readConversationHistory(chatDir);
const prompt   = buildPrompt(boardId, cardId, history);
const cwd      = boardDir && fs.existsSync(boardDir) ? boardDir : undefined;

let response = '';
try {
  response = stripCopilotFooter(runCopilotPrompt(prompt, cwd)).trim();
} catch (err) {
  const lastUser = [...history].reverse().find(l => l.startsWith('User:')) ?? '';
  response = `Sorry, I could not reach the LLM right now. (${String(err?.message ?? err).slice(0, 120)})`;
  console.error(`[demo-chat-handler] LLM call failed: ${err?.message ?? err}`);
}

// Write assistant response as next serial file
const serialMatch = String(lastChatFile).match(/^(\d+)/);
const nextSerial  = serialMatch ? parseInt(serialMatch[1], 10) + 1 : 1;
const nextName    = `${String(nextSerial).padStart(3, '0')}-assistant.txt`;
const nextPath    = path.join(chatDir, nextName);

try {
  fs.writeFileSync(nextPath, response + '\n', 'utf-8');
  console.log(`[demo-chat-handler] boardId="${boardId}" cardId="${cardId}" → ${nextPath}`);
} catch (err) {
  console.error(`[demo-chat-handler] write failed: ${err.message}`);
}
 *
 * Protocol (invoked by reusable-server-runtime after a user message is persisted):
 *   node demo-chat-handler.js --boardId <id> --cardId <id> --extraEncJson <base64json>
 *
 * --extraEncJson decodes to: { chatDir: "<abs>", boardDir: "<abs>", lastChatFile: "<filename>" }
 *
 * Responsibilities:
 *   1. Read the full conversation history from chatDir (all *_user.txt / *-assistant.txt files).
 *   2. Read the current card state from boardDir/board-graph.json (card_data, fetched_sources,
 *      computed_values for cardId) to use as grounding context.
 *   3. Build a system prompt that situates the LLM as an assistant for this specific card,
 *      including the card's current data as context.
 *   4. Send the conversation + context to the LLM (Copilot via CLI).
 *   5. Write the response as <nextSerial>-assistant.txt to chatDir.
 *
 * Design principle:
 *   The chat is always scoped to the card where the chat button is embedded.
 *   The card's current state (card_data, computed_values, fetched_sources) is the primary
 *   grounding context. The LLM should help the user understand, explore, or act on that card's
 *   data — not give generic answers disconnected from the card's content.
 *
 *   The system prompt should encourage the LLM to:
 *   - Reference the card's actual values when answering
 *   - Ask clarifying questions if the user's intent is ambiguous
 *   - Suggest next steps relevant to the card's domain
 *   - Be concise (the chat is embedded in a card, not a full chat window)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : null;
}

const boardId  = getArg('--boardId') || '';
const cardId   = getArg('--cardId') || '';
const extraStr = getArg('--extraEncJson') || '';

let extra = {};
try {
  extra = JSON.parse(Buffer.from(extraStr, 'base64').toString('utf-8'));
} catch {
  console.error('[demo-chat-handler] could not parse --extraEncJson');
  process.exit(0);
}

const { chatDir, boardDir, lastChatFile } = extra;

if (!chatDir || !lastChatFile) {
  console.error('[demo-chat-handler] --extraEncJson must contain chatDir and lastChatFile');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Read full conversation history from chatDir
// ---------------------------------------------------------------------------
function readConversationHistory(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => /^\d+[-_](user|assistant)\.txt$/i.test(f));
    files.sort();
  } catch {
    return [];
  }
  return files.map(f => {
    const role = /user/i.test(f) ? 'user' : 'assistant';
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf-8').trim(); } catch {}
    return { role, text };
  });
}

// ---------------------------------------------------------------------------
// 2. Read card state from board-graph.json
// ---------------------------------------------------------------------------
function readCardState(bDir, cId) {
  if (!bDir) return null;
  try {
    const boardGraph = JSON.parse(fs.readFileSync(path.join(bDir, 'board-graph.json'), 'utf-8'));
    // board-graph.json wraps a LiveGraph snapshot; cards live under graph.nodes
    const nodes = boardGraph?.graph?.nodes ?? boardGraph?.nodes ?? {};
    return nodes[cId] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Build system prompt grounded in the card's current state
// ---------------------------------------------------------------------------
function buildSystemPrompt(cId, cardState) {
  const lines = [
    `You are a helpful assistant embedded inside a live card (id: "${cId}") on a data dashboard.`,
    'Your role is to help the user understand, interpret, and act on the data shown in this card.',
    'Always ground your answers in the card\'s actual current values. Be concise — this is an embedded card chat, not a full conversation window.',
    'If the user\'s question is ambiguous, ask one short clarifying question.',
    'Suggest relevant next steps or insights when appropriate.',
    '',
    '--- Current card state ---',
  ];

  if (cardState) {
    if (cardState.card_data && Object.keys(cardState.card_data).length > 0) {
      lines.push('card_data: ' + JSON.stringify(cardState.card_data, null, 2));
    }
    if (cardState.computed_values && Object.keys(cardState.computed_values).length > 0) {
      lines.push('computed_values: ' + JSON.stringify(cardState.computed_values, null, 2));
    }
    if (cardState.fetched_sources && Object.keys(cardState.fetched_sources).length > 0) {
      lines.push('fetched_sources: ' + JSON.stringify(cardState.fetched_sources, null, 2));
    }
  } else {
    lines.push('(card state not available)');
  }

  lines.push('--- End card state ---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 4. Build the full prompt (system + conversation turns)
// ---------------------------------------------------------------------------
function buildPrompt(systemPrompt, history) {
  const parts = [systemPrompt, ''];
  for (const turn of history) {
    parts.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`);
  }
  parts.push('Assistant:');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 5. Call LLM (Copilot CLI)
// ---------------------------------------------------------------------------
function resolveCopilotExecutable() {
  const envBin = process.env.COPILOT_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['copilot'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const candidates = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return candidates.find(p => /\.(cmd|exe|bat)$/i.test(p)) ?? candidates[0] ?? 'copilot';
    } catch {}
  } else {
    try {
      const out = execFileSync('which', ['copilot'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? 'copilot';
    } catch {}
  }
  return 'copilot';
}

function stripCopilotFooter(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (
    lines.length >= 3 &&
    /^Changes\b/i.test(lines[lines.length - 3]) &&
    /^Requests\b/i.test(lines[lines.length - 2]) &&
    /^Tokens\b/i.test(lines[lines.length - 1])
  ) {
    lines.splice(lines.length - 3, 3);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function runLLM(prompt) {
  const copilotBin = resolveCopilotExecutable();
  try {
    const raw = execFileSync(copilotBin, ['--allow-all'], {
      input: String(prompt),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000,
    });
    return stripCopilotFooter(raw).trim();
  } catch (err) {
    if (process.platform === 'win32') {
      try {
        const raw = execFileSync('cmd.exe', ['/d', '/c', 'copilot --allow-all'], {
          input: String(prompt),
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60000,
        });
        return stripCopilotFooter(raw).trim();
      } catch {}
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const history     = readConversationHistory(chatDir);
const cardState   = readCardState(boardDir, cardId);
const systemPmt   = buildSystemPrompt(cardId, cardState);
const fullPrompt  = buildPrompt(systemPmt, history);

let response = '';
try {
  response = runLLM(fullPrompt);
} catch (err) {
  // Fallback: acknowledge the message so the user sees something
  const lastUserMsg = [...history].reverse().find(t => t.role === 'user')?.text ?? '';
  response = `I received your message ("${lastUserMsg.slice(0, 80)}") but could not reach the LLM right now. Please try again.`;
  console.error(`[demo-chat-handler] LLM call failed: ${err && err.message || err}`);
}

// Derive next serial and write assistant response
const serialMatch = String(lastChatFile).match(/^(\d+)/);
const nextSerial  = serialMatch ? parseInt(serialMatch[1], 10) + 1 : 1;
const nextName    = `${String(nextSerial).padStart(3, '0')}-assistant.txt`;
const nextPath    = path.join(chatDir, nextName);

try {
  fs.writeFileSync(nextPath, response + '\n', 'utf-8');
  console.log(`[demo-chat-handler] boardId="${boardId}" cardId="${cardId}" wrote response → ${nextPath}`);
} catch (err) {
  console.error(`[demo-chat-handler] write failed: ${err.message}`);
}
