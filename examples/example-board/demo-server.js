#!/usr/bin/env node

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMultiBoardServerRuntime,
  createRuntimeRequestDispatcher,
  isRuntimeRoute,
} from './reusable-server-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.DEMO_SERVER_PORT || 7799);
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

const runtime = createMultiBoardServerRuntime({
  apiBasePath: '/api/boards',
  defaultTaskExecutorPath: process.env.DEMO_TASK_EXECUTOR_PATH || path.join(__dirname, 'demo-task-executor.js'),
});

const dispatch = createRuntimeRequestDispatcher(runtime);

// Board-id segment regex: /api/boards/:boardId/...
const BOARD_SEG_RE = /^\/api\/boards\/([^/]+)\/(.+)$/;

function jsonReply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleDemoSetup(req, res, boardId) {
  const url = new URL(req.url, 'http://localhost');
  const reset = String(url.searchParams.get('reset') || '').toLowerCase() === 'true';
  try {
    const result = runtime.performDemoSetup(boardId, reset);
    jsonReply(res, 200, result);
  } catch (err) {
    jsonReply(res, err.statusCode || 500, { error: String((err && err.message) || err) });
  }
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Route: demo-setup is handled here in demo-server (host concern)
  const boardSegMatch = pathname.match(BOARD_SEG_RE);
  if (boardSegMatch && boardSegMatch[2] === 'demo-setup') {
    void handleDemoSetup(req, res, boardSegMatch[1]);
    return;
  }

  // All other /api/boards routes are handled by the reusable runtime
  void dispatch(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[demo-server] setup dir: ${runtime.setupDir}`);
  console.log(`[demo-server] boards config: ${runtime.setupDir}/boards-config.json`);
  console.log('[demo-server] endpoints:');
  console.log(`  GET  ${runtime.apiBasePath}                          <- list boards`);
  console.log(`  POST ${runtime.apiBasePath}  {id, label?}            <- register board`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/demo-setup`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/bootstrap`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/sse`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/board-status`);
  console.log(`  PATCH ${runtime.apiBasePath}/:boardId/cards/:id`);
  console.log(`  POST ${runtime.apiBasePath}/:boardId/cards/:id/actions`);
  console.log(`  POST ${runtime.apiBasePath}/:boardId/cards/:id/files`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/cards/:id/files/:idx`);
  console.log(`  GET  ${runtime.apiBasePath}/:boardId/cards/:id/chats`);
});
