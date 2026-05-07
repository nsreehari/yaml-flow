# TMP Migration Plan: Server Runtime Portability

Status: In progress — Phases 0–7 largely complete (branch `board-server-runtime-refactor`)
Scope: Migrate server runtime from local-fs/local-process assumptions to adapter-first portability (Azure/Firebase-ready)

## Goals
- Keep runtime API behavior stable while removing direct host dependencies.
- Make storage, invocation, and notification pluggable through adapters.
- Preserve demo-server as a local host profile while enabling Azure/Firebase host profiles.

## Non-goals
- Rewriting board compute logic or card semantics.
- Replacing all demo-only scripts in one step.
- Immediate full parity for every local shell utility in Azure profile.

## Phase 0: Baseline and Freeze
Checklist:
- [x] Capture current API route contract and response shapes.
- [x] Freeze a regression suite for migration gates:
  - [x] `tests/examples/demo-server.test.ts` (8 tests)
  - [x] `tests/cli/board-live-cards-public-api.test.ts`
  - [x] `tests/cli/artifacts-store-lib.test.ts`
  - [x] `tests/cli/card-store-patch.test.ts`
  - [x] portfolio tracker e2e (`examples/browser/boards/portfolio-tracker/portfolio-tracker-public.js`)
- [x] Define pass/fail matrix for local profile and Azure profile.

Done: All 808 tests pass (804 passed, 4 skipped). Integration tests added for both FS-backed and Firebase-backed server runtime (`tests/server-runtime/`).

## Phase 1: Registry and Metadata Abstraction
Checklist:
- [x] Move multi-board registry storage to artifacts-backed server-meta store.
- [x] Accept `serverMetaStoreRef` as kindref from demo server config.
- [ ] Add explicit tests for registry persistence semantics independent of fs path assumptions.
- [ ] Add conflict/consistency behavior tests for concurrent board registration.

## Phase 2: Chat/File Artifact Contract Cleanup
Checklist:
- [x] Chat index and chat signal (`.index.json`, `.processing`) flow through artifacts semantics.
- [x] Move runtime-side `.processing` lifecycle to artifacts store logic.
- [x] Align demo chat-handler contract with runtime extra payload fields.
- [x] Remove dependency on `--cleanOnExit` path argument in runtime invocation contract.
- [ ] Add dedicated regression for handler failure and marker cleanup behavior.

## Phase 3: Remove Remaining Direct FS Glue in Runtime Core
Checklist:
- [x] Remove eager board directory scaffolding during board registration.
- [x] Replace direct card directory scanning (`fs.readdirSync`) with `CardSourceAdapter` interface.
- [x] Remove direct `.chat-handler` file reads from runtime; chat-handler ref flows through `board.getConfig()` config store.
- [x] Remove direct script existence checks (`fs.existsSync`) from runtime; validation via `InvocationAdapter.describe()`.
- [x] Eliminate direct fallback fs writes/unlinks for chat marker lifecycle; markers use artifacts store.

Done: `src/server-runtime/index.ts` has zero `node:fs`, `node:path`, `node:child_process`, `node:net`, or `node:os` imports. All platform access flows through injected adapters.

## Phase 4: Invocation Adapterization
Checklist:
- [x] Introduce explicit `InvocationAdapter` interface for task/chat/inference execution dispatch.
- [x] Refactor runtime to emit invocation requests through adapter, not `spawn` directly.
- [x] Provide local adapter implementation (Node `spawn` in demo-server.js).
- [x] `InvocationAdapter.describe()` — optional pre-init validation (confirms handler kind).
- [ ] Provide Azure adapter implementation (queue/service bus/function trigger).
- [ ] Add correlation IDs and idempotent dispatch semantics.

Done: Firebase adapter dispatches via `boardAdapter.dispatchExecution()`. Demo-server uses `spawn`-based adapter. Runtime is fully decoupled from process spawning.

## Phase 5: Notification Transport Adapterization
Checklist:
- [x] Replace named-pipe/local-socket coupling with `NotificationTransport` interface.
- [x] Notification channels use `KindValueRef` (e.g., `{kind:'named-pipe', value:path}` or `{kind:'firestore-watch', value:path}`).
- [x] Keep SSE fanout in runtime but source events from adapter-neutral channel.
- [x] Provide local adapter implementation (named pipes in demo-server.js).
- [ ] Provide Azure adapter implementation (pub/sub service).
- [ ] Add reconnection/replay policy for SSE clients.

Done: Runtime's `NotificationTransport.subscribe()` takes a `KindValueRef`, not a raw pipe path. Transport mechanism is fully host-determined.

## Phase 6: Storage Adapter Profile for Azure/Firebase
Checklist:
- [x] Introduce non-fs board platform adapter wiring in runtime construction.
- [x] Ensure all refs used in runtime are backend-neutral (no hardcoded `::fs-path::` assumptions in runtime logic).
- [x] Firebase adapter implemented (`firebase-board-adapter.ts`, `firestore-adapters.ts`) with Firestore-backed KV/blob stores.
- [x] `artifactsAdapter` option allows separate blob storage for files/chats (preserves backward-compatible FS layouts).
- [ ] Map KV/blob/json stores to Azure-native backends.
- [ ] Add migration strategy for existing local data to cloud-backed stores.

Done: Firebase Cloud Function entry point (`firebase-entry.ts`) fully operational with Firestore-backed adapters. LocalStorage adapter (`board-livecards-localstorage`) bundles the server runtime for browser use.

## Phase 7: Host Boundary Hardening (Demo Server vs Runtime)
Checklist:
- [x] Keep host-only concerns strictly in host layer (`demo-setup`, WorkIQ proxy, local prep).
- [x] Ensure runtime owns all board APIs including SSE route behavior.
- [x] Retired `board-livecards-server-runtime.js` (1494-line monolith deleted).
- [x] Rewrote `demo-server.js` (~340 lines) as thin host that injects adapters into platform-free runtime.
- [x] Generic `boards: BoardContextConfig[]` — no domain-specific names (base/gandalf) in runtime.
- [ ] Define host callback contract (`serverUrl` and optional capabilities) as versioned schema.
- [ ] Add compatibility tests for host/runtime handoff boundaries.

## Phase 8: Operational Readiness
Checklist:
- [ ] Structured logs and tracing IDs across runtime, adapters, and handlers.
- [ ] Health/readiness endpoints for runtime + adapter dependencies.
- [ ] Retry, timeout, and dead-letter behavior documented and tested.
- [ ] Security review for secrets/config injection and external call surfaces.

## Phase 9: Cutover Plan
Checklist:
- [ ] Dual-profile deployment (local + Azure) with parity checks.
- [ ] Canary board subset on Azure profile.
- [ ] Rollback strategy with data consistency constraints documented.
- [ ] Final remove/deprecate direct fs runtime code paths once parity is proven.

## Suggested Execution Order (Remaining Work)
1. Phase 1/2 test gaps: registry persistence, concurrent registration, handler failure regression.
2. Phase 4/5 Azure adapters: invocation via queue/service bus, notification via pub/sub.
3. Phase 6 Azure storage: map KV/blob to Azure-native backends, data migration strategy.
4. Phase 7 contract: versioned host callback schema, host/runtime handoff compatibility tests.
5. Phase 8 operational readiness.
6. Phase 9 cutover.
5. Phase 7 host boundary contract/versioning.
6. Phase 8-9 operational hardening and cutover.

## Migration Gate for Each Phase
- [ ] Tests green (targeted + impacted suites).
- [ ] Build green.
- [ ] Portfolio tracker e2e green.
- [ ] Focused commit with clear scope and rollback note.

## Risks to Track
- Hidden coupling between runtime bootstrapping and card mutation persistence.
- SSE event timing regressions during notification transport changes.
- Handler/executor contract drift during invocation refactor.
- Data model divergence between local fs profile and Azure profile.
