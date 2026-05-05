# TMP Migration Plan: Server Runtime Portability

Status: Draft working checklist
Scope: Migrate server runtime from local-fs/local-process assumptions to adapter-first portability (Azure-ready)

## Goals
- Keep runtime API behavior stable while removing direct host dependencies.
- Make storage, invocation, and notification pluggable through adapters.
- Preserve demo-server as a local host profile while enabling Azure host/runtime profile.

## Non-goals
- Rewriting board compute logic or card semantics.
- Replacing all demo-only scripts in one step.
- Immediate full parity for every local shell utility in Azure profile.

## Phase 0: Baseline and Freeze
Checklist:
- [ ] Capture current API route contract and response shapes.
- [ ] Freeze a regression suite for migration gates:
  - [ ] `tests/examples/demo-server.test.ts`
  - [ ] `tests/cli/board-live-cards-public-api.test.ts`
  - [ ] `tests/cli/artifacts-store-lib.test.ts`
  - [ ] `tests/cli/card-store-patch.test.ts`
  - [ ] portfolio tracker e2e (`examples/browser/boards/portfolio-tracker/portfolio-tracker-public.js`)
- [ ] Define pass/fail matrix for local profile and Azure profile.

Done so far:
- [x] Core targeted suites and portfolio e2e are green after recent runtime changes.

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
- [ ] Replace direct card directory scanning (`fs.readdirSync` over cards dirs) with adapter-backed card source abstraction.
- [ ] Remove direct `.chat-handler` file reads from runtime and use config/control-store abstraction.
- [ ] Remove direct script existence checks (`fs.existsSync`) from runtime; validate via adapter capability checks.
- [ ] Eliminate direct fallback fs writes/unlinks for chat marker lifecycle.

## Phase 4: Invocation Adapterization
Checklist:
- [ ] Introduce explicit InvocationAdapter interface for task/chat/inference execution dispatch.
- [ ] Refactor runtime to emit invocation requests through adapter, not `spawn` directly.
- [ ] Provide local adapter implementation (current behavior).
- [ ] Provide Azure adapter implementation (queue/service bus/function trigger).
- [ ] Add correlation IDs and idempotent dispatch semantics.

## Phase 5: Notification Transport Adapterization
Checklist:
- [ ] Replace named-pipe/local-socket coupling with NotificationAdapter.
- [ ] Keep SSE fanout in runtime but source events from adapter-neutral channel.
- [ ] Provide local adapter implementation (named pipes/socket) and Azure adapter implementation (pub/sub service).
- [ ] Add reconnection/replay policy for SSE clients.

## Phase 6: Storage Adapter Profile for Azure
Checklist:
- [ ] Introduce non-fs board platform adapter wiring in runtime construction.
- [ ] Map KV/blob/json stores to Azure-native backends.
- [ ] Ensure all refs used in runtime are backend-neutral (no hardcoded `::fs-path::` assumptions in runtime logic).
- [ ] Add migration strategy for existing local data to cloud-backed stores.

## Phase 7: Host Boundary Hardening (Demo Server vs Runtime)
Checklist:
- [ ] Keep host-only concerns strictly in host layer (`demo-setup`, WorkIQ proxy, local prep).
- [ ] Ensure runtime owns all board APIs including SSE route behavior.
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

## Suggested Execution Order (Focused Commits)
1. Phase 3 residual fs glue removal (small slices, each with tests).
2. Phase 4 invocation adapter extraction with local adapter first.
3. Phase 5 notification adapter extraction with local adapter first.
4. Phase 6 Azure storage profile implementation.
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
