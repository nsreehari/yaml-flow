# TODO_FEATURES

Purpose: Track the live-cards and board-live-cards CLI evolution work and complete items one by one.

## Execution Policy

- Work one item at a time from top to bottom unless reprioritized.
- Mark items as DISCUSS before implementation when design details are needed.
- Keep schema compatibility explicit between browser and server.
- Prefer npm-exposed CLI usage paths for external black-box integration.

## Backlog

- [x] 1. upsert-card CLI command with glob support
  - Status: DONE
  - Goal: board-live-cards-cli upsert-card --rg <dir> --card-glob "..."
  - Notes: support windows and unix glob styles, deterministic order, duplicate-card handling

- [x] 2. enforce single-source parity for live-cards schema (browser vs server)
  - Status: DONE
  - Goal: no drift between schema/live-cards.schema.json and browser/live-cards.schema.json
  - Notes: add test/guard that fails if schemas diverge

- [x] 3. board-live-cards-cli npm availability hardening
  - Status: DONE
  - Goal: keep canonical CLI path stable for package consumers
  - Notes: wrapper/bin path stabilized, direct tsx runner path hardened, package bin cleanup applied

- [ ] 4. AI agent manifest/notes for live-card schema create/update
  - Status: DISCUSS
  - Goal: define simple manifest and guardrails before writing notes
  - Notes: pending user-guided discussion on required explanations

- [x] 5. board-live-cards CLI command reference page and docs linking
  - Status: DONE
  - Goal: create docs page (for example docs/board-live-cards-cli.html) and link from docs index
  - Notes: added docs/board-live-cards-cli.html and linked from README/examples catalog

- [ ] 6. AI tool manifest for board-live-cards-cli (agent + MCP style)
  - Status: DISCUSS
  - Goal: describe board-live-cards-cli as callable tool with input/output contracts
  - Notes: align with existing inference/tooling conventions

- [x] 7. inference adapter support for live-cards
  - Status: DONE
  - Goal: map inference adapters into live-card workflows with clear boundaries
  - Notes: resolved by directing all LLM calls through source_defs → compute → provides. Inference adapter retained as undocumented/advanced mechanism (portfolio-tracker is the reference). agent-instructions and schema updated to reflect one-mechanism model.

- [x] 8. richer rendering for files/chats/etc. in live-cards
  - Status: DONE
  - Goal: improve browser rendering and define server payload shape for these card types
  - Notes: SVG icons, auto-grow textarea, enter-to-send, chat/files modal disabled state via card_data.features.chat.disabled / card_data.features.files.disabled; ingest-board.js retired (deprecated header added, removed from docs)

- [x] 9. generalize portfolio-tracker into reusable demo simulation framework
  - Status: DONE
  - Goal: run multiple scenarios and synthetic situations with shared harness
  - Notes: added step-machine scenario harness with reusable runner and multiple scenario files (baseline + price-shock)

- [x] 10. define standard status object shape for live cards and boards
  - Status: DONE
  - Goal: stable status schema for runtime, UI, and integration contracts
  - Notes: added `status --json` output contract and schema/board-status.schema.json (v1)

## Completed Recently

- [x] Canonical npm CLI runner path established
- [x] Portfolio tracker end-to-end automated test suite added
- [x] CLI-focused test suite stabilized for no-popup test mode
- [x] upsert-card glob support added to board-live-cards-cli
- [x] schema parity guard test added for browser vs server live-cards schema
- [x] board-live-cards status object schema (v1) + `status --json`
- [x] step-machine scenario harness for reusable synthetic portfolio runs
