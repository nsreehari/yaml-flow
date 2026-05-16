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

const input = readJsonStdin();
const userText = typeof input.userText === 'string' ? input.userText : '';
const chatTimeMs = Number.isFinite(Number(input.chatTimeMs)) && Number(input.chatTimeMs) > 0
  ? Math.min(120000, Math.floor(Number(input.chatTimeMs)))
  : 0;

if (chatTimeMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, chatTimeMs));
}

process.stdout.write(JSON.stringify({
  replyText: `Echo: ${userText}`,
}));
