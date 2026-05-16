#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import { createFsBoardChatStorage } from 'yaml-flow/board-live-cards-node';

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

const input = readJsonStdin();
const boardSetupRoot = typeof input.boardSetupRoot === 'string' ? input.boardSetupRoot : '';
const boardRuntimeDir = typeof input.boardRuntimeDir === 'string' ? input.boardRuntimeDir : 'runtime';
const cardId = typeof input.cardId === 'string' ? input.cardId : '';

try {
  if (!boardSetupRoot || !cardId) {
    process.stderr.write('chat-clear-processing requires boardSetupRoot and cardId\n');
    process.exit(1);
  }

  const boardDir = path.join(boardSetupRoot, boardRuntimeDir || 'runtime');
  if (!fs.existsSync(boardDir)) {
    process.stdout.write(JSON.stringify({ cleared: true, skipped: true }));
    process.exit(0);
  }

  const chatStorage = createFsBoardChatStorage(boardDir);
  chatStorage.setProcessing(cardId, false);
  process.stdout.write(JSON.stringify({ cleared: true }));
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}
