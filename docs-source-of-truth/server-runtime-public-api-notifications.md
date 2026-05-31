# Source of Truth - Server Runtime via Public API + Notifications

## Scope

This document defines the stable architecture for board server runtimes.
It applies to reusable server runtime and demo server hosts.


## Runtime Boundary

The server runtime must interact with board state only through:
- Board public API (`createBoardLiveCardsPublic`)
- Card-store public API (`createCardStorePublic`)
- Notification stream published by board platform adapters

Direct CLI invocation and direct output-file scanning are not part of the runtime data path.


## Canonical Data Sources

For any board, server runtime state is built from exactly three sources:
1. Card definitions: card-store public API (`get` all cards)
2. Board outputs/status snapshot: board public API and output-store-backed public methods
3. Incremental changes: board change notifications (`computed_values`, `data_object`, `card_refreshed`, `status`)

No runtime feature should depend on reading `runtime-out` files as the primary source of truth.


## Notification Model

Board notifications are drain-cycle batched.
A batch may contain:
- `computed_values` events
- `data_object` events
- `card_refreshed` events
- one `status` event for the completed cycle

`card_refreshed` is accumulated and emitted with the same batch as other events.
It is not emitted inline per handler call.


## SSE Model

SSE is notification-driven.

Rules:
- On SSE connect, emit one full snapshot payload for immediate hydration.
- After hydration, emit updates only when notifications are received.
- Keepalive comments are allowed but must not trigger full state recomputation.
- Polling loops that call `process-accumulated-events` on a timer are not part of SSE update logic.


## Snapshot Construction

A full payload for browser runtime hydration must include:
- `cardDefinitions`
- `statusSnapshot`
- `dataObjectsByToken`
- `cardRuntimeById` (per-card object with `schema_version`, `card_id`, `card_data`, `computed_values`)

Construction policy:
- Card definitions come from card-store public API.
- Status and outputs come from public API / public output-store methods.
- Incremental notification state is merged into an in-memory board cache.


## Board Processing Triggers

Mutating endpoints (patch/action/file/chat) are responsible for:
- updating card source-of-truth via card-store API
- invoking board public operations (`upsertCard`, `retrigger`, `processAccumulatedEvents` where needed)

SSE delivery relies on notification events from those operations, not on file watchers.


## Multi-Board and Sidecar Boards

Each board runtime context owns:
- board public API instance
- card-store public API instance
- notification channel + consumer
- in-memory snapshot cache
- SSE subscribers

If a service has multiple board contexts (for example default + gandalf), each context maintains independent notification/cache state, and outbound payloads are merged at API layer.


## Host Layer (demo-server)

Host server responsibilities:
- board registry/routing
- host-specific setup actions
- proxy endpoints unrelated to board core (for example external AI tools)

Host server should not provide CLI path plumbing for board runtime operations.


## Testing Contract

Tests for server runtime should validate:
- hydration payload correctness from public APIs
- notification-driven SSE updates without polling loops
- card/action/file flows still trigger board updates and SSE broadcasts
- multi-board context isolation and merge behavior

CLI-specific tests belong to CLI surfaces, not to server runtime behavior.


## Naming conventions

- Notification event `kind` values use `snake_case`: `computed_values`, `data_object`, `card_refreshed`, `status`. Event payload fields use `camelCase` (`cardId`, `key`, `values`, `payload`, `card`).
- Snapshot envelope fields use `camelCase`: `cardDefinitions`, `statusSnapshot`, `dataObjectsByToken`, `cardRuntimeById`.
- Per-card runtime object keys under `cardRuntimeById[id]` use `snake_case` (`schema_version`, `card_id`, `card_data`, `computed_values`) because they mirror the card-namespace protocol — see [mcp-api-tools.md](./mcp-api-tools.md#naming-conventions) for the cross-surface convention table.
