#!/usr/bin/env node
// demo-chat-handler.js — Echo chat handler for demo/example boards.
//
// Invoked by reusable-server-runtime after a user chat message is persisted,
// when a .chat-handler file is present in the board runtime directory.
//
// Invocation contract:
//   node demo-chat-handler.js --boardId <id> --cardId <id> --extra <json>
//
// --extra JSON shape: { chatDir: "<abs path>", boardDir: "<abs path>", lastChatFile: "<filename>" }
//
// This demo handler:
//   1. Reads the content of the last chat file (the user message just written).
//   2. Computes the next serial by incrementing the leading number from lastChatFile.
//   3. Writes <nextSerial>-assistant.txt to chatDir with: "Echoing <original content>"

import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : null;
}

const boardId     = getArg('--boardId') || '';
const cardId      = getArg('--cardId') || '';
const extraStr    = getArg('--extraEncJson') || '';

let extra = {};
try {
  extra = JSON.parse(Buffer.from(extraStr, 'base64').toString('utf-8'));
} catch {
  console.error('[demo-chat-handler] could not parse --extra JSON');
  process.exit(0);
}

const { chatDir, lastChatFile } = extra;

if (!chatDir || !lastChatFile) {
  console.error('[demo-chat-handler] --extra must contain chatDir and lastChatFile');
  process.exit(0);
}

// Read the user message from the last chat file.
const lastChatPath = path.join(chatDir, lastChatFile);
let content = '';
try {
  content = fs.readFileSync(lastChatPath, 'utf-8').trim();
} catch (err) {
  console.error(`[demo-chat-handler] could not read ${lastChatPath}: ${err.message}`);
  process.exit(0);
}

// Derive next serial by incrementing the leading digits in lastChatFile.
// e.g. "007_user.txt" → 7 → next = 8 → "008-assistant.txt"
const serialMatch = String(lastChatFile).match(/^(\d+)/);
const nextSerial = serialMatch ? parseInt(serialMatch[1], 10) + 1 : 1;
const nextName = `${String(nextSerial).padStart(3, '0')}-assistant.txt`;
const nextPath = path.join(chatDir, nextName);

try {
  fs.writeFileSync(nextPath, `Echoing ${content}\n`, 'utf-8');
  console.log(`[demo-chat-handler] boardId="${boardId}" cardId="${cardId}" wrote echo → ${nextPath}`);
} catch (err) {
  console.error(`[demo-chat-handler] write failed: ${err.message}`);
  process.exit(0);
}
