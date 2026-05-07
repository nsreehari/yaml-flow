/**
 * firebase-entry.ts
 *
 * Firebase Cloud Functions v2 entry point for the board server runtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPLOYMENT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. Create a Firebase project at https://console.firebase.google.com
 *   2. Enable Firestore (Native mode) and upgrade to Blaze plan
 *   3. `npm install -g firebase-tools && firebase login`
 *   4. Copy this into your functions/ directory and configure
 *   5. `firebase deploy --only functions`
 *
 * FREE TIER COVERAGE (Blaze pay-as-you-go):
 *   - Cloud Functions v2: 2M invocations/month, 400K GB-s free
 *   - Firestore: 1 GiB storage, 50K reads, 20K writes/day
 *   - No Cloud Storage dependency — all data in Firestore
 *   - Billing account required but charges $0 within free quotas
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Client → Cloud Function (this file)
 *              ↓ warmUp (load Firestore caches)
 *              ↓ createSingleBoardServerRuntime (platform-free)
 *              ↓ handleRuntimeApi(req, res, url)
 *              ↓ flush (persist pending Firestore writes)
 *              → Response
 *
 * Each request is self-contained: warm up caches, handle, flush.
 * Cloud Functions v2 may reuse instances so caches survive across requests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import type { Request, Response } from 'firebase-functions/v2/https';
import { createSingleBoardServerRuntime } from '../index.js';
import type {
  SingleBoardRuntimeOptions,
  RuntimeRequest,
  RuntimeResponse,
  CardSourceAdapter,
  InvocationAdapter,
} from '../types.js';
import {
  createFirebaseBoardPlatformAdapter,
  type FirebaseBoardAdapter,
} from './firebase-board-adapter.js';
import { createFirestoreServerMetaStore } from './firestore-adapters.js';

// ============================================================================
// Firebase init
// ============================================================================

const app = initializeApp();
const db = getFirestore(app);

// ============================================================================
// Configuration — set via environment variables or Firebase config
//
// BOARD_ID:           Board identifier (default: 'default')
// FUNCTION_URL:       Public URL of this function (auto-detected in v2)
// CARDS_COLLECTION:   Firestore collection for seed card definitions
//                     (default: 'boards/{boardId}/seed-cards')
// ============================================================================

const BOARD_ID = process.env.BOARD_ID || 'default';

// ============================================================================
// Firestore-backed CardSourceAdapter
//
// Reads card definitions from a Firestore collection.
// Upload card YAML/JSON to this collection before first use.
// ============================================================================

function createFirestoreCardSource(
  boardId: string,
): CardSourceAdapter & { warmUp(): Promise<void> } {
  const collectionPath = process.env.CARDS_COLLECTION || `boards/${boardId}/seed-cards`;
  const col = db.collection(collectionPath);
  let cards: Array<Record<string, unknown>> = [];

  return {
    async warmUp(): Promise<void> {
      const snapshot = await col.get();
      cards = [];
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data && typeof data === 'object') {
          // Ensure the card has an id field
          if (!data.id) data.id = doc.id;
          cards.push(data as Record<string, unknown>);
        }
      }
    },
    listCards(): Array<Record<string, unknown>> {
      return [...cards];
    },
  };
}

// ============================================================================
// Firebase InvocationAdapter
//
// Dispatches via the board adapter's dispatchExecution.
// For HTTP-based executors/chat-handlers, this uses fetch().
// ============================================================================

function createFirebaseInvocationAdapter(
  boardAdapter: FirebaseBoardAdapter,
): InvocationAdapter {
  return {
    async invoke(ref, args) {
      return boardAdapter.adapter.dispatchExecution(ref, args);
    },
  };
}

// ============================================================================
// Adapt Express req/res → RuntimeRequest/RuntimeResponse
// ============================================================================

function adaptRequest(req: Request): RuntimeRequest {
  return {
    method: req.method,
    url: req.url,
    headers: req.headers as Record<string, string | string[] | undefined>,
    on(event: string, listener: (...args: unknown[]) => void): void {
      req.on(event, listener as any);
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | Uint8Array> {
      // Cloud Functions v2 pre-parses the body; wrap it as async iterable
      const body = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      let done = false;
      return {
        next() {
          if (done) return Promise.resolve({ value: undefined as any, done: true });
          done = true;
          return Promise.resolve({ value: body, done: false });
        },
        return() { return Promise.resolve({ value: undefined as any, done: true }); },
        throw(e: unknown) { return Promise.reject(e); },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

function adaptResponse(res: Response): RuntimeResponse {
  return {
    writeHead(statusCode: number, headers?: Record<string, string | number>): void {
      res.status(statusCode);
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          res.set(key, String(value));
        }
      }
    },
    write(data: string | Buffer): boolean {
      res.write(data);
      return true;
    },
    end(data?: string | Buffer): void {
      if (data) {
        res.send(data);
      } else {
        res.end();
      }
    },
  };
}

// ============================================================================
// Cloud Function handler
// ============================================================================

export const boardApi = onRequest(
  {
    region: process.env.FUNCTION_REGION || 'us-central1',
    // Cloud Functions v2 settings optimized for free tier
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 1,      // Stay within free tier
    minInstances: 0,      // Scale to zero when idle
    concurrency: 10,      // Handle multiple requests per instance
  },
  async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type,x-file-name',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      });
      res.status(204).send('');
      return;
    }

    const boardId = BOARD_ID;
    const functionUrl = process.env.FUNCTION_URL
      || `https://${req.hostname}${req.baseUrl || ''}`;

    try {
      // Create board adapter + card source
      const boardAdapterBundle = createFirebaseBoardPlatformAdapter({
        db,
        boardId,
        functionUrl,
        onWarn: (msg) => console.warn(`[board:${boardId}]`, msg),
      });

      const cardSource = createFirestoreCardSource(boardId);
      const invocationAdapter = createFirebaseInvocationAdapter(boardAdapterBundle);

      // Warm up all Firestore caches in parallel
      await Promise.all([
        boardAdapterBundle.warmUp(),
        cardSource.warmUp(),
      ]);

      // Build runtime options
      const runtimeOptions: SingleBoardRuntimeOptions = {
        apiBasePath: '/api/board',
        boardId,
        base: {
          label: 'base',
          boardAdapter: boardAdapterBundle.adapter,
          baseRef: { kind: 'firestore', value: `boards/${boardId}` },
          cardStoreRef: `::firestore::boards/${boardId}/card-store`,
          outputsStoreRef: `::firestore::boards/${boardId}/outputs`,
          cardSource,
        },
        invocationAdapter,
        logger: {
          info: (...args: unknown[]) => console.log(`[board:${boardId}]`, ...args),
          warn: (...args: unknown[]) => console.warn(`[board:${boardId}]`, ...args),
          error: (...args: unknown[]) => console.error(`[board:${boardId}]`, ...args),
        },
        serverUrl: functionUrl,
      };

      const runtime = createSingleBoardServerRuntime(runtimeOptions);

      // Parse URL and route
      const url = new URL(req.url, `https://${req.hostname}`);
      const handled = await runtime.handleRuntimeApi(
        adaptRequest(req),
        adaptResponse(res),
        url,
      );

      // Flush pending Firestore writes before returning
      await boardAdapterBundle.flush();

      if (!handled) {
        res.status(404).json({
          error: 'Not found',
          hint: `Available endpoints: GET /api/board/bootstrap, GET /api/board/sse, GET /api/board/board-status, PATCH /api/board/cards/:id, POST /api/board/cards/:id/actions`,
        });
      }
    } catch (err: unknown) {
      console.error(`[board:${boardId}] unhandled error:`, err);
      res.status(500).json({ error: (err as Error)?.message || 'Internal server error' });
    }
  },
);
