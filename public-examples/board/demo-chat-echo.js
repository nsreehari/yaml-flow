#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  createArtifactsStore,
  createChatArtifactsStore,
  createFsBoardPlatformAdapter,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

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

function resolveChatStoreContext(extra, chatDir) {
  if (typeof extra.chatsBlobBasePath === 'string' && typeof extra.chatsKeyPrefix === 'string') {
    return {
      chatsRoot: extra.chatsBlobBasePath,
      cardPrefix: String(extra.chatsKeyPrefix).split('/')[0],
    };
  }
  if (chatDir) {
    return {
      chatsRoot: path.dirname(chatDir),
      cardPrefix: path.basename(chatDir),
    };
  }
  return { chatsRoot: '', cardPrefix: '' };
}

const extra = readJsonStdin();
const chatDir = resolveChatDir(extra);
const { chatsRoot, cardPrefix } = resolveChatStoreContext(extra, chatDir);
const lastChatFile = typeof extra.lastChatFile === 'string' ? extra.lastChatFile : '';

if (!chatDir || !lastChatFile || !chatsRoot || !cardPrefix) {
  console.log(JSON.stringify({ result: 'failure', data: {}, error: 'missing chatDir/lastChatFile' }));
  process.exit(0);
}

const lastChatPath = path.join(chatDir, lastChatFile);
let userText = '';
try {
  userText = fs.readFileSync(lastChatPath, 'utf-8').trim();
} catch {
  console.log(JSON.stringify({ result: 'failure', data: {}, error: 'could not read last chat file' }));
  process.exit(0);
}

const replyText = `Echo: ${userText}`;

try {
  const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: chatsRoot }));
  const adapter = createFsBoardPlatformAdapter(baseRef, { suppressSpawn: true });
  const artifacts = createArtifactsStore(adapter.blobStorage(''));
  const chats = createChatArtifactsStore(artifacts, { indexFileName: '.index.json' });
  const serial = chats.nextSerial(cardPrefix);
  const storedName = `${String(serial).padStart(3, '0')}_assistant.txt`;

  artifacts.putText(`${cardPrefix}/${storedName}`, replyText + '\n', 'text/plain; charset=utf-8');
  chats.appendIndexRecord(cardPrefix, {
    serial,
    role: 'assistant',
    stored_name: storedName,
    path: `${cardPrefix}/chats/${storedName}`,
    updated_at: new Date().toISOString(),
  });
  if (typeof extra.chatProcessingMarkerKey === 'string' && extra.chatProcessingMarkerKey.trim()) {
    artifacts.remove(extra.chatProcessingMarkerKey.trim());
  }
  console.log(JSON.stringify({ result: 'success', data: { replyFile: storedName, replyText } }));
} catch (err) {
  console.log(JSON.stringify({ result: 'failure', data: {}, error: err instanceof Error ? err.message : String(err) }));
}