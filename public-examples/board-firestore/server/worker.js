#!/usr/bin/env node
/**
 * board-firestore/server/worker.js
 *
 * Long-running worker server for the Firestore-backed board.
 * Runs three things in one Node.js process:
 *
 *   1. Queue lane runners — drain worker-queue, chat-queue, process-queue
 *   2. Board control-plane HTTP — GET/POST /api/board/* for browser SPA
 *   3. Callback endpoint — POST /api/board/callback/* for execution webhooks
 *
 * Environment variables:
 *   GOOGLE_APPLICATION_CREDENTIALS  Path to Firebase service account JSON key
 *   FIREBASE_PROJECT_ID             Firebase project ID
 *   BOARD_ID                        Firestore board document ID (default: "default")
 *   WORKER_PORT                     HTTP listen port (default: 7900)
 */

import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createSingleBoardServerRuntime } from 'yaml-flow/board-live-cards-server-runtime';
import { createHostedBoardQueueLaneRegistry } from 'yaml-flow/server-jobs-queue-runner';
import { startQueueLaneRunners } from 'yaml-flow/board-live-cards-node';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreBoardAdapter } from './adapters/firestore-board-adapter.js';

// ── Firebase Admin SDK init ────────────────────────────────────────────────────
if (getApps().length === 0) {
  initializeApp({
    credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? './service-account.json'),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

const db = getFirestore();

// ── Config ─────────────────────────────────────────────────────────────────────
const BOARD_ID = process.env.BOARD_ID ?? 'default';
const PORT = Number(process.env.WORKER_PORT ?? 7900);

// ── Helper: build a b64 ref string (matches serializeRef in yaml-flow) ──────────
function makeRef(kind, value) {
  return `b64:${Buffer.from(JSON.stringify({ kind, value })).toString('base64url')}`;
}

// ── Firestore board adapter ────────────────────────────────────────────────────
const boardAdapter = createFirestoreBoardAdapter(db, BOARD_ID);

// ── Single-board runtime ───────────────────────────────────────────────────────
const runtime = createSingleBoardServerRuntime({
  boardId: BOARD_ID,
  boards: [
    {
      label: `Board — ${BOARD_ID}`,
      boardAdapter,
      baseRef: { kind: 'firestore', value: `boards/${BOARD_ID}` },
      cardStoreRef: makeRef('firestore', `boards/${BOARD_ID}/cards`),
      outputsStoreRef: makeRef('firestore', `boards/${BOARD_ID}/runtime-out`),
    },
  ],
  invocationAdapter: {
    /**
     * Route execution requests to the appropriate handler.
     * For worker queue dispatch, yaml-flow uses boardAdapter.dispatchExecution internally.
     * This adapter is the last-resort fallback for refs not handled by boardAdapter.
     */
    async invoke(ref, _args) {
      return { dispatched: false, error: `No invocation handler for ${ref?.howToRun ?? '?'}` };
    },
  },
  logger: {
    info: (msg, ...args) => console.log(`[worker:${BOARD_ID}] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[worker:${BOARD_ID}] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[worker:${BOARD_ID}] ${msg}`, ...args),
  },
});

// ── Queue lane runners ─────────────────────────────────────────────────────────
const stopRunners = startQueueLaneRunners(
  createHostedBoardQueueLaneRegistry({
    boardId: BOARD_ID,
    runtime,
    boardAdapter,
    logger: {
      info: (msg, ...args) => console.log(`[queue:${BOARD_ID}] ${msg}`, ...args),
      warn: (msg, ...args) => console.warn(`[queue:${BOARD_ID}] ${msg}`, ...args),
      error: (msg, ...args) => console.error(`[queue:${BOARD_ID}] ${msg}`, ...args),
    },
  }),
);

// ── HTTP server ────────────────────────────────────────────────────────────────
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  try {
    const handled = await runtime.handleRuntimeApi(req, res, url);
    if (!handled) sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    console.error(`[worker:${BOARD_ID}] unhandled error for ${req.method} ${req.url}:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`[board-firestore/worker] Listening on http://localhost:${PORT}`);
  console.log(`[board-firestore/worker] Board ID : ${BOARD_ID}`);
  console.log(`[board-firestore/worker] Firebase project: ${process.env.FIREBASE_PROJECT_ID ?? '(auto-detect)'}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────────
function shutdown() {
  console.log('[board-firestore/worker] Shutting down...');
  stopRunners();
  server.close(() => {
    console.log('[board-firestore/worker] HTTP server closed.');
    process.exit(0);
  });
  // Force exit after 10 s if connections linger
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
