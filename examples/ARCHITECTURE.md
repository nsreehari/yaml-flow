# yaml-flow — Architecture & Reuse Guide

A quick reference for anyone integrating yaml-flow into their own stack,
or adapting it to different infrastructure.

---

## Package exports — layered architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  YOUR HOST SHIM  (thin, you write — a few dozen lines)           │
│  Adapt your platform's request/response → RuntimeRequest/        │
│  RuntimeResponse. Wire SSE streaming. Construct adapters.        │
├──────────────────────────────────────────────────────────────────┤
│  PLATFORM ADAPTER  →  board-live-cards-node                      │
│  FS + local-process reference implementation.                    │
│  Replace this layer for different storage/invocation infra.      │
│  Implement: BoardPlatformAdapter, CardStore, ArtifactsStore, ... │
├──────────────────────────────────────────────────────────────────┤
│  SERVER ORCHESTRATION  →  board-live-cards-server-runtime        │
│  Routes, board lifecycle, chat/file orchestration.               │
│  Platform-free — all I/O injected via adapters.                  │
│  Works on Node HTTP, Azure Functions, Cloudflare Workers, etc.   │
├──────────────────────────────────────────────────────────────────┤
│  STORAGE CONTRACTS  →  card-store-public, artifacts-store-public │
│  Interfaces only. No implementations. Code against these.        │
├──────────────────────────────────────────────────────────────────┤
│  CORE LOGIC  →  . / board-live-cards-public, step-machine-public │
│  Pure computation — card graph, event engine, step machine.      │
│  No FS, no Node, no HTTP. Works anywhere (browser included).     │
└──────────────────────────────────────────────────────────────────┘
```

**Reuse everything except the platform adapter layer.**
To move from Node+FS to Azure Functions+Cosmos DB:
- Implement your own `BoardPlatformAdapter` backed by Cosmos/Azure Blob
- Write a thin host shim that maps Azure `HttpRequest` → `RuntimeRequest`
- Extend ref dispatch for new `howToRun` kinds via `createExecutionRefInvoker({ transports, syncTransports })` — no layer replacement needed
- Everything else — server runtime, core logic, client bundles — is unchanged

---

## Worker side — board-worker-adapter

Used by any **external process** the board dispatches work to:
task executors, chat handlers, inference workers, etc.

Provides the full worker contract in a single zero-dependency file:
- `parseRef` / `serializeRef` — wire-format ref decoding
- `blobStorageForRef` — resolve a ref to its storage backend (`read`/`write`)
- `reportComplete` / `reportFailed` — call back to the board on completion
- `ExecutionRef`, `TaskCallback`, `BlobStorage` — the stable protocol types

**Adapting to different infrastructure:**

| What changes | What to do |
|---|---|
| Storage backend (Cosmos, Azure Blob, S3) | Add a new `case` in `blobStorageForRef()` for the new `KindValueRef.kind` |
| Callback transport (Service Bus, queue) | Add a new `case` in `reportComplete`/`reportFailed` for the new `howToRun` value |
| Worker hosting (Azure Functions, Lambda) | Nothing here — the worker reads its inRef and calls `reportComplete`; hosting is transparent |

Tip: copy this file into your worker project and extend locally.
The interfaces are the stable contract; backends are just switch cases.

---

## Browser bundles

All browser bundles are standalone IIFE files — no bundler required.
Include them with a `<script>` tag. Each sets a global on `window`.

### compute-jsonata.js → `window.jsonataSync`

Vendored jsonata engine for browser bundles that need in-browser card computation.

```html
<script src="compute-jsonata.js"></script>
```

No public API — just sets `window.jsonataSync` for other bundles to pick up.

---

### live-cards.js → `window.LiveCard`

**UI rendering engine** — turns board state (card models) into interactive HTML.

Renders card view definitions (tables, metrics, charts, markdown, forms, badges, etc.)
into DOM elements. Handles card-to-card `requires`/`provides` token wiring,
action buttons, chat panels, file attachments, and editable fields.

```html
<script src="live-cards.js"></script>
<script>
  const engine = LiveCard.init({
    resolve,          // (nodeId) → card model
    onPatch,          // called when user edits a field
    onAction,         // called on action button click
    getChatMessages,  // () → messages for chat panel
    markdown,         // optional: (text) → html  (e.g. marked.parse)
    sanitize,         // optional: (html) → safe html  (e.g. DOMPurify.sanitize)
    chartLib,         // optional: Chart.js constructor
  });
</script>
```

**Optional external JS** — all injected, none bundled:

| Library | Purpose | Inject via |
|---|---|---|
| [Bootstrap 5](https://getbootstrap.com/) | Layout, forms, badges | `<link>` + `<script>` (CSS + JS) |
| [Chart.js](https://www.chartjs.org/) | Chart rendering in cards | `chartLib` config param |
| [marked](https://marked.js.org/) | Markdown → HTML | `markdown` config param |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Sanitize markdown output | `sanitize` config param |

Bootstrap CSS is required for layout. Everything else is optional — if not provided,
charts fall back to tables and markdown renders as escaped plain text.

---

## Typical script load order (full browser setup)

```html
<!-- 1. Optional external libs -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5/dist/css/bootstrap.min.css">
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5/dist/js/bootstrap.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js"></script>

<!-- 2. yaml-flow bundles -->
<script src="live-cards.js"></script>
```
