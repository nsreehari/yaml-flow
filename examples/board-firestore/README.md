# board-firestore

Example of a [yaml-flow](https://www.npmjs.com/package/yaml-flow) board backed by **Cloud Firestore** (Firebase).

## Architecture

```
Browser SPA                     Node.js Worker (server/worker.js)
──────────────                  ──────────────────────────────────
Firebase JS SDK ──> Firestore <── Firebase Admin SDK
                        │
                   board cards,
                   queue messages,
                   blob storage
```

- **Worker** — runs queue lanes (board-worker, chat-agent, process-accumulated) and exposes an HTTP control-plane on port 7900 for the browser SPA.
- **Browser** — uses the `ServerRuntimeControlface` IIFE (`browser/server-runtime-controlface.js`) with a Firestore JS SDK adapter to read card state and trigger board operations.

## Firestore data layout

All data lives under `boards/{boardId}/`:

| Subcollection | Purpose |
|---|---|
| `kv-{namespace}/` | `AsyncKVStorage` (card state, config, etc.) |
| `cards/` | Card store (KV, keyed by card ID) |
| `runtime-out/` | Computed outputs store |
| `journal/` | Append-only board journal |
| `worker-queue/` | Board worker task queue |
| `chat-queue/` | Chat agent dispatch queue |
| `process-queue/` | processAccumulated trigger queue |
| `blobs-{namespace}/` | Blob/artifact storage |
| `scratch/` | Ephemeral scratch storage |
| `archive-stream-{name}/` | Named archive streams |
| `archive-blob-{name}/` | Named archive blob collections |
| `locks/board-lock` | Distributed lock document |

> **Required Firestore composite index** for each queue collection:  
> Fields: `dead` (ASC), `visibleAfter` (ASC)

## Setup

1. Create a Firebase project and enable Firestore.
2. Generate a service account key and save it as `server/service-account.json` (or set `GOOGLE_APPLICATION_CREDENTIALS` env var).
3. Install dependencies:

```bash
npm install
```

4. Start the worker:

```bash
FIREBASE_PROJECT_ID=your-project npm run worker
```

The worker listens on `http://localhost:7900` by default.

## Browser usage

Include the IIFE bundle in your HTML:

```html
<script src="/browser/server-runtime-controlface.js"></script>
```

Then use `browser/board-runtime.js` as a reference for constructing the runtime with the Firebase JS SDK.

## Firestore security rules (development)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /boards/{boardId}/{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```
