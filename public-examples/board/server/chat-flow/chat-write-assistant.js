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
const cardId = typeof input.cardId === 'string' ? input.cardId : '';
const serverUrl = typeof input.serverUrl === 'string' ? input.serverUrl.replace(/\/$/, '') : '';
const apiBasePath = typeof input.apiBasePath === 'string' ? input.apiBasePath : '/api/board';
const replyText = typeof input.replyText === 'string' ? input.replyText : '';

if (!cardId || !serverUrl) {
  process.stderr.write('chat-write-assistant requires cardId and serverUrl\n');
  process.exit(1);
}

try {
  const postUrl = `${serverUrl}${apiBasePath}/cards/${encodeURIComponent(cardId)}/chats`;
  const postRes = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'assistant', text: replyText, files: [], done: true }),
  });
  if (!postRes.ok) {
    const err = await postRes.text();
    process.stderr.write(`chat-write-assistant POST failed: ${err}\n`);
    process.exit(1);
  }
  const postData = await postRes.json();
  process.stdout.write(JSON.stringify({ replyId: postData?.id, replyText }));
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}
