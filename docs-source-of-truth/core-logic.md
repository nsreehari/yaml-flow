# Source of Truth — Board Live Cards Runtime Logic


## Source Fetch Lifecycle

Each source entry tracks three ordered request-cycle markers and one terminal outcome: `queueRequestedToken`, `lastRequestedToken`, `lastCompletedToken`, `lastCompletionStatus`.

Each dispatched fetch also carries `rqt`, a request-cycle identity token. In the current implementation it is encoded as an ordered timestamp-like value, so newer request cycles sort after older ones. The runtime uses that ordering for stale-result checks, but the semantic role of `rqt` is request identity, not fetch completion time.

**Rules that never change:**
- `queueRequestedToken` is the newest request the card wants fulfilled.
- `lastRequestedToken` is the newest request actually dispatched.
- `lastCompletedToken` is the newest request cycle that reached a terminal outcome.
- `lastCompletionStatus` is the outcome for `lastCompletedToken`: `success`, `failure`, or `not-started` before any terminal outcome has been recorded.
- None of these fields are ever cleared once written.
- The token fields always advance forward in token order.

**When a card runs (non-update path — task started or retriggered):**

The card handler marks a fresh request by writing `queueRequestedToken = now`.
- If the current dispatched cycle is already terminal (`lastCompletedToken == lastRequestedToken`), it dispatches immediately: `lastRequestedToken = queueRequestedToken`, and the fetch carries `rqt = lastRequestedToken`.
- Otherwise a fetch is already in-flight, so it does nothing now. The queued token is already recorded, and completion of the in-flight fetch will decide whether re-dispatch is needed.
- If multiple new requests arrive while a fetch is in-flight, only `queueRequestedToken` advances. Intermediate queued tokens are overwritten, so only the latest queued token survives.

**When a fetch result arrives (task-progress / update path):**

The delivery is identified by its `rqt` token.
- If `rqt ≤ lastCompletedToken`, the terminal result is stale and is ignored, regardless of whether that older completion was a success or a failure.
- Otherwise the result is accepted: the fetched file is committed, `lastCompletedToken = rqt`, and `lastCompletionStatus = success`.
- After accepting the result, if `queueRequestedToken > lastCompletedToken`, a new fetch is dispatched immediately with `lastRequestedToken = queueRequestedToken`.

**Other lifecycle rules:**
- A failed fetch is terminal for that request cycle: `lastCompletedToken = rqt` and `lastCompletionStatus = failure`.
- Required sources must clear their queued request cycle before card completion. Optional sources do not block completion.
- A `source_def` with truthy `skip_when` is excluded from that card run before any source-fetch request is queued.
- A retrigger starts a fresh request cycle for the card's sources.


## Multi-Source Cards and `task-completed`

When a card has multiple `source_defs`, each source advances through its own request cycle independently.

`task-completed` is a card-level state, not a per-source state. It means:
- every required source for the card has cleared its queued request cycle
- the card's computed outputs have been produced and published

For a required source, the queued request cycle is cleared only when:
- `queueRequestedToken == lastRequestedToken`
- and the current dispatched cycle is terminal (`lastCompletedToken == lastRequestedToken`)

The terminal outcome for that completed cycle is given by `lastCompletionStatus`:
- `success`: the cycle produced accepted source data
- `failure`: the cycle terminated without accepted source data

So a card must not enter `task-completed` while any required source is still in-flight, or while a newer queued request for that source is still waiting to be dispatched. Optional sources may still be pending or continue fetching after the card reaches `task-completed`.


## Drain Cycle

The drain cycle is the core processing loop that runs whenever the board has accumulated events in its journal (triggered by `upsertCard`, `retrigger`, source callbacks, etc.).

**The problem it solves:** multiple rapid-fire updates can arrive before the board has a chance to process them. A naive approach would process only the first and leave the rest stale. The TX accumulator loop ensures every update is fully resolved before the board state is saved.

**How it works:**

The cycle starts by reading all unprocessed journal events. It creates in-memory overlays for card runtime state, fetched source data, computed values, and data objects — so that nothing is written to disk until the full cycle is complete.

It then creates a ReactiveGraph for this cycle. Card handlers are wired with two callbacks:
- A completion callback that captures the result in a pending list (TX) instead of writing to the journal.
- Deferred write callbacks for computed values and data objects, which buffer to memory instead of hitting disk.

The loop then runs: push the pending events into the graph, wait for all handlers to finish, collect any new completions into TX, and repeat until nothing new is produced. Each iteration processes another wave of cascading completions.

Once the loop finishes and nothing more is pending, the board state (graph snapshot) is committed to disk. Only after that are the deferred writes flushed — computed values, data objects, card runtime state, and source data — in that order.

Finally, any pending source-fetch execution requests are dispatched to the configured task executor.

**Key invariants:**
- Card completions never go to the file journal during a drain cycle — they stay in memory and are fed directly back into the same ReactiveGraph instance.
- The file journal only receives failures and source-progress callbacks (which come from out-of-process fetches).
- The board snapshot is always committed with the graph in its fully-resolved final state.
- All disk writes happen after the snapshot is committed, keeping the snapshot consistent.


## Relay Lock and Drain Scheduling

Every drain cycle runs under an atomic relay lock. The lock serves two purposes simultaneously, and these are not coincidental — they express the same safety guarantee at different levels.

**Atomicity:** only one drain cycle can run at a time. This prevents two concurrent callers from both reading the current board snapshot, making independent changes, and then racing to write conflicting results back.

**Relay baton:** when a caller tries to start a drain but the lock is already held, it does not wait and does not retry. Instead it exits immediately and relies on the current holder to pick up its work. This is safe because the holder always reads fresh journal events at the start of its cycle — any event written by the skipping caller before it attempted the lock will be seen by the holder when it reads the journal.

**The continuation:** after a drain cycle finishes and the lock is released, a continuation runs. The continuation checks whether any new journal events arrived while the lock was held (e.g. from concurrent `upsertCard` calls that arrived mid-cycle). If so, it immediately starts a new drain. It also calls the platform-level `requestProcessAccumulated` hook, which in the CLI context spawns a detached child process to handle source fetches and any further processing. In the in-process (browser/JS API) context this hook is absent and the self-check loop handles it directly.

**Platform variations:**
- **CLI / filesystem:** the lock is a filesystem lockfile. Multiple processes can call the board independently; only one will run the drain, and concurrent callers relay their work to whichever process holds the lock at that moment.
- **In-process (browser / JS public API):** the lock is an in-memory flag. The same process drives everything. `requestProcessAccumulated` is not wired up — instead the continuation's self-check loop handles any events that accumulated while the drain was running.

The result is that drains are naturally serialized without any queuing or backpressure logic. Concurrent writers simply append to the journal and exit; the drain holder reads the full accumulated journal on each cycle.


## ReactiveGraph — waitForHandlers

The ReactiveGraph has a `waitForHandlers()` method that pauses until all currently running handler promises have settled, without disposing the graph. This is what allows the TX accumulator loop to safely inspect what the handlers produced and then feed new events back in. It is distinct from `dispose({wait:true})`, which also shuts the graph down so no further events can be pushed.


## Card Handler — Injection Points

The card handler function accepts two optional write overrides in addition to its required completion callback. When the drain cycle provides these, writes to computed values and data objects go to in-memory buffers instead of the filesystem. This is what makes the deferred-flush pattern possible. When the overrides are not provided (e.g. in tests or simpler contexts), the handler falls back to writing directly through the output store adapter.


## Test Suites

1. `portfolio-tracker-public.js` — in-process JS integration tests (T0–T3)
2. `portfolio-t4.js` — isolated rapid-fire restart test (portfolio-form only)
3. `portfolio-tracker.py` — Python CLI-based end-to-end tests (T0–T5)