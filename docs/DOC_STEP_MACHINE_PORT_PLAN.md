# Step-Machine Port Plan

Branch: `feat/step-machine-declarative`

## Stock of changes in this worktree

### Committed
1. `e47ff90`: replace inline JS handlers with declarative JSONata compute handlers
2. `abccf2a`: declarative handler model with `type: compute-jsonata` and `type: ref` (KindRef)
3. (Plus `c7c6070` fix from before this work)

### Uncommitted (in-flight scope)
1. `step-machine-cli.js`: removed input-transforms/output-transforms; added `argsMassaging`
   (cmdTemplate, bodyTemplate); `createRefStepHandler` rewritten to wrap transport-only
   success/failure; `normalizeHandlerResult` tolerant of arbitrary JSON.
2. `examples/cli/step-machine-cli/portfolio-tracker/portfolio-tracker.flow.yaml`: removed
   transforms, uses `argsMassaging.bodyTemplate`.
3. Portfolio-tracker handler scripts: dropped `{result, data}` envelope; raw object on
   stdout, exit non-zero on failure (`_board-cli.js`, add-cards, init-board, poll-status,
   reset-board-dir, retrigger, status, update-holdings, wait-completed, write-prices).
4. Demo scripts cleaned same way: `jsonata-init-board-cli.js`, `step2-double-cli.js`;
   `jsonata-init-board.flow.yaml` split into compute → ref → compute.
5. Tests: rewrote two transform tests to argsMassaging; updated invalid-JSON test to
   reflect new contract; all 21 tests pass.

### What did NOT happen yet (deviation from approved plan)
1. No extraction into `src/step-machine-public/`.
2. `step-machine-cli.js` is still the monolith doing engine semantics + adapter concerns
   + CLI wiring.
3. No use of existing `KVStorage`, `ExecutionRef`, process-interface adapters from
   `src/cli/common/`.
4. No Python port, no cloud refs.

## Where we deviated from the original approved plan

1. Phase 1 was supposed to be only "remove inline + add compute". We did that, then
   kept piling more semantics into `step-machine-cli.js` (argsMassaging, transport
   mapping, normalization).
2. Phase 2 (extract `src/step-machine-public/`) was supposed to come before any further
   semantic additions. We skipped it. That is the root of the "framework vs adapter"
   confusion.

## Phased plan (proposed)

### Phase 1 — Declarative handler model (done, needs commit)
1. `type: compute-jsonata` and `type: ref` with KindRef.
2. Inline handlers removed.
3. argsMassaging on ref (cmdTemplate / bodyTemplate).
4. Transport-only intent mapping; raw payload contract.
5. Tests passing (21/21).
6. Action: commit current uncommitted work as Phase 1 closure.

### Phase 2 — Extract platform-free `src/step-machine-public/`
1. New module exports `createStepMachineRunner({ flow, store, invoke, initialData })`.
2. Pure engine: handler resolution, compute-jsonata, validations, transitions,
   `produces_data` filtering.
3. Handler return contract: `{ result, data, error? }` only.
4. Reuse existing interfaces:
   1. `KVStorage` from `src/cli/common/storage-interface.ts`
   2. `ExecutionRef` from `src/cli/common/execution-interface.ts`
5. No Node-only imports (no `fs`, no `child_process`, no `path`).
6. `step-machine-cli.js` becomes thin wiring:
   1. Parse args
   2. Build FS-based KVStorage adapter
   3. Build Node spawn-based invoke adapter (handles process specifics, normalizes
      to `{ result, data }`)
   4. Call `createStepMachineRunner(...)`
   5. Print result

### Phase 3 — Execution adapter normalization
1. Single boundary: `invoke(ref, input) => { result, data, error? }`.
2. Node spawn adapter:
   1. exit `0` ⇒ `result: success`
   2. non-zero ⇒ `result: failure` with stderr as error
   3. payload pass-through; engine never inspects shape
3. HTTP adapter (future): 2xx ⇒ success, else failure; body becomes `data`.
4. Azure Function + Cosmos adapter (future): function outcome ⇒ result; response/blob
   ref ⇒ data.
5. `argsMassaging` stays on the ref, evaluated by the adapter (urlTemplate/bodyTemplate
   are transport concerns).

### Phase 4 — Python CLI port `pycli/py-step-machine-cli/`
1. Mirror `src/step-machine-public/` semantics in Python.
2. `pyjsonata` for compute/validations.
3. `subprocess` invoke adapter.
4. Same flow YAML format.

### Phase 5 — Cloud-portable execution refs
1. Wire HTTP / Azure Function adapters through the same `invoke` interface.
2. Flow YAMLs unchanged; only `howToRun` value changes.

## Open design decisions (locked)

1. **Output transforms placement**
   1. No inline output-transforms on ref. If reshaping is needed, add a compute step
      after the ref step.
   2. Future option: `errorWhen` / `errorMessage` only if logical-failure routing on
      transport-success responses is needed. Skip until needed.

2. **Handler return contract (strict)**
   1. `result`: `success | failure | timeout | <custom-intent>`
   2. `data`: any (object preferred for downstream addressability; blobs allowed when
      adapter sets them).
   3. `error`: optional string.
   4. Engine never inspects payload shape; only routes on `result` and projects from
      `data` via `produces_data`.

3. **Storage usage in step-machine-public**
   1. Use `KVStorage` interface only; no `fs` imports.
   2. CLI builds the FS-backed KVStorage adapter.

## Framework vs adapter boundary (key insight)

1. Framework concern: engine semantics, normalized handler contract.
2. Adapter concern: how a particular transport (process, HTTP, Azure Function) maps its
   own success/failure signal into `{ result, data, error? }` and how it carries the
   payload (JSON, blob, reference).
3. Framework never deals with stdout/stderr/HTTP status/Cosmos read response directly.
   Each adapter normalizes to the contract before calling into the engine.
