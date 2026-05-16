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

const extra = readJsonStdin();
const cardId = typeof extra.cardId === 'string' ? extra.cardId : '';
const serverUrl = typeof extra.serverUrl === 'string' ? extra.serverUrl.replace(/\/$/, '') : '';
const lastEntryId = typeof extra.lastChatEntryId === 'string' ? extra.lastChatEntryId : '';
const apiBasePath = typeof extra.apiBasePath === 'string' ? extra.apiBasePath : '/api/board';

if (!cardId || !serverUrl) {
  console.log(JSON.stringify({ result: 'failure', data: {}, error: 'missing cardId or serverUrl' }));
  process.exit(0);
}

// Read the last user message by fetching the chat history
let userText = '';
try {
  const chatsUrl = `${serverUrl}${apiBasePath}/cards/${encodeURIComponent(cardId)}/chats`;
  const res = await fetch(chatsUrl);
  if (res.ok) {
    const data = await res.json();
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const lastSeenIndex = lastEntryId
      ? messages.findIndex(m => typeof m?.id === 'string' && m.id === lastEntryId)
      : -1;
    const newerMessages = lastSeenIndex >= 0 ? messages.slice(lastSeenIndex + 1) : messages;
    const lastUser = newerMessages.filter(m => m.role === 'user').at(-1);
    userText = typeof lastUser?.text === 'string' ? lastUser.text : '';
  }
} catch (err) {
  console.log(JSON.stringify({ result: 'failure', data: {}, error: `could not fetch chat history: ${err?.message || err}` }));
  process.exit(0);
}

if (!userText) {
  console.log(JSON.stringify({ result: 'success', data: { skipped: true, reason: 'no new user message after lastChatEntryId' } }));
  process.exit(0);
}

const replyText = `Echo: ${userText}`;

// Write assistant reply via the chat API; done=true also clears the processing flag
try {
  const postUrl = `${serverUrl}${apiBasePath}/cards/${encodeURIComponent(cardId)}/chats`;
  const postRes = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'assistant', text: replyText, files: [], done: true }),
  });
  if (!postRes.ok) {
    const err = await postRes.text();
    console.log(JSON.stringify({ result: 'failure', data: {}, error: `chat POST failed: ${err}` }));
    process.exit(0);
  }
  const postData = await postRes.json();
  console.log(JSON.stringify({ result: 'success', data: { replyText, id: postData?.id } }));
} catch (err) {
  console.log(JSON.stringify({ result: 'failure', data: {}, error: err instanceof Error ? err.message : String(err) }));
}
