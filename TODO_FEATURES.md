# TODO_FEATURES

Purpose: Track the live-cards and board-live-cards CLI evolution work and complete items one by one.

## Execution Policy

- Work one item at a time from top to bottom unless reprioritized.
- Mark items as DISCUSS before implementation when design details are needed.
- Keep schema compatibility explicit between browser and server.
- Prefer npm-exposed CLI usage paths for external black-box integration.

## Backlog

- [x] 1. add-cards CLI command with glob support
  - Status: DONE
  - Goal: board-live-cards-cli add-cards --rg <dir> --card-glob "..."
  - Notes: support windows and unix glob styles, deterministic order, duplicate-card handling

- [x] 2. enforce single-source parity for live-cards schema (browser vs server)
  - Status: DONE
  - Goal: no drift between schema/live-cards.schema.json and browser/live-cards.schema.json
  - Notes: add test/guard that fails if schemas diverge

- [ ] 3. board-live-cards-cli npm availability hardening
  - Status: READY
  - Goal: keep canonical CLI path stable for package consumers
  - Notes: verify package contents and bin entry continuously

- [ ] 4. AI agent manifest/notes for live-card schema create/update
  - Status: DISCUSS
  - Goal: define simple manifest and guardrails before writing notes
  - Notes: pending user-guided discussion on required explanations

- [ ] 5. board-live-cards CLI command reference page and docs linking
  - Status: READY
  - Goal: create docs page (for example docs/board-live-cards-cli.html) and link from docs index
  - Notes: include command purpose, options, examples, expected outputs

- [ ] 6. AI tool manifest for board-live-cards-cli (agent + MCP style)
  - Status: DISCUSS
  - Goal: describe board-live-cards-cli as callable tool with input/output contracts
  - Notes: align with existing inference/tooling conventions

- [ ] 7. inference adapter support for live-cards
  - Status: DISCUSS
  - Goal: map inference adapters into live-card workflows with clear boundaries
  - Notes: define when inference runs, how outputs bind, and failure semantics

- [ ] 8. richer rendering for files/chats/etc. in live-cards
  - Status: DISCUSS
  - Goal: improve browser rendering and define server payload shape for these card types
  - Notes: include example boards showing supported card varieties

- [ ] 9. generalize portfolio-tracker into reusable demo simulation framework
  - Status: DISCUSS
  - Goal: run multiple scenarios and synthetic situations with shared harness
  - Notes: evaluate using yaml-flow step engine for orchestration

- [ ] 10. define standard status object shape for live cards and boards
  - Status: DISCUSS
  - Goal: stable status schema for runtime, UI, and integration contracts
  - Notes: include state transitions and lifecycle semantics

## Completed Recently

- [x] Canonical npm CLI runner path established
- [x] Portfolio tracker end-to-end automated test suite added
- [x] CLI-focused test suite stabilized for no-popup test mode
- [x] add-cards glob support added to board-live-cards-cli
- [x] schema parity guard test added for browser vs server live-cards schema
