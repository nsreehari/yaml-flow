#!/usr/bin/env node

import * as fs from 'node:fs';
import * as http from 'node:http';

export function readJsonStdin() {
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

function httpJson(method, targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const data = Buffer.from(JSON.stringify(payload), 'utf-8');
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        let body = null;
        try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export async function invokeControlplaneTool({ serverUrl, boardId, tool, args }) {
  const trimmedServerUrl = String(serverUrl || '').trim().replace(/\/+$/, '');
  const trimmedBoardId = String(boardId || '').trim();
  const trimmedTool = String(tool || '').trim();
  if (!trimmedServerUrl) throw new Error('serverUrl is required');
  if (!trimmedBoardId) throw new Error('boardId is required');
  if (!trimmedTool) throw new Error('tool is required');

  const result = await httpJson('POST', `${trimmedServerUrl}/api/boards/${encodeURIComponent(trimmedBoardId)}/mcp-controlplane`, {
    tool: trimmedTool,
    args,
  });

  if (result.status !== 200) {
    const message = result.body && typeof result.body === 'object' && typeof result.body.error === 'string'
      ? result.body.error
      : `controlplane tool failed with status ${result.status}`;
    throw new Error(message);
  }

  return result.body;
}

async function main() {
  const input = readJsonStdin();
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  if (action !== 'set-chat-processing-done') {
    throw new Error('shared.js requires action="set-chat-processing-done"');
  }
  const serverUrl = typeof input.serverUrl === 'string' ? input.serverUrl : '';
  const boardId = typeof input.boardId === 'string' ? input.boardId : '';
  const cardId = typeof input.cardId === 'string' ? input.cardId : '';
  if (!cardId) throw new Error('cardId is required');

  const result = await invokeControlplaneTool({
    serverUrl,
    boardId,
    tool: 'setstate.chat-processing-done',
    args: { board_id: boardId, card_id: cardId },
  });

  process.stdout.write(JSON.stringify(result));
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}