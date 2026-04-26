# yaml-flow

Two workflow engines in one package. Pick the model that fits your problem.

[![npm version](https://badge.fury.io/js/yaml-flow.svg)](https://www.npmjs.com/package/yaml-flow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

```
npm install yaml-flow
```

## Public Surfaces

yaml-flow is not only a low-level npm library. It exposes three practical consumption surfaces:

1. **Library APIs**
  Use the package imports when you want to embed workflow logic directly in your application.
  The primary library APIs are `yaml-flow/step-machine`, `yaml-flow/continuous-event-graph`, and `yaml-flow/inference`.
  `yaml-flow/batch` is also available as a convenience utility for concurrent processing of item collections using Step Machine, Live Event Graph, or graph-of-graphs execution patterns.

2. **Live-Cards / Boards Package Layer**
  This is a reusable higher-level package pattern built from yaml-flow engines, schemas, browser runtime assets, and CLI orchestration.
  It includes:
  - `board-live-cards-cli`
  - browser runtime assets under `browser/`
  - `yaml-flow/card-compute`

3. **Step-machine CLI**
  `step-machine-cli` is the standalone operational runner for YAML step-machine workflows with inline handlers, CLI handlers, and JSONata transforms.
  For durable and operator-controlled runs, use `--store file --store-dir ...` plus `--pause`, `--resume`, and `--status`.

## Documentation Map

- Main orientation: `README.md`
- Runnable examples: `examples/index.html`
- Docs landing page: `docs/index.html`
- Board live-cards CLI reference: `docs/board-live-cards-cli.html`
- Step-machine CLI reference: `docs/step-machine-cli.html`
- Browser runtime guide: `docs/browser-runtime-livecards-boards.html`
- Schemas: `schema/` and `browser/live-cards.schema.json`

## Repository Organization

- `dist/` contains the built library output.
- `schema/` contains public config and contract schemas.
- `browser/` contains shipped browser-consumable runtime assets.
- `examples/` contains runnable examples for the public surfaces.
- `docs/` contains deeper reference and design material for repo/GitHub readers.
- `app/` is best treated as demo/showcase code, not as the primary public documentation surface.

## Board Live Cards CLI (Canonical External Path)

When installed from npm, use the package-exposed command:

```bash
npx board-live-cards-cli --help
```

If installed as a dependency in another project, invoke it the same way via your package runner:

```bash
board-live-cards-cli --help
```

This is the canonical black-box entrypoint for external usage.

Command reference: `docs/board-live-cards-cli.html`
Status JSON schema: `schema/board-status.schema.json`

Step-machine CLI reference: `docs/step-machine-cli.html`

## Which Mode Do I Need?

yaml-flow ships two execution models. They solve fundamentally different problems.

| | **Step Machine** | **Event Graph** |
|---|---|---|
| **Mental model** | Flowchart — each step decides what runs next | Dependency graph — tasks self-select when their inputs are ready |
| **Core function** | `applyStepResult(flow, state, step, result) → newState` | `next(graph, state) → eligibleTasks` + `apply(state, event, graph) → newState` |
| **Config shape** | `steps:` with `transitions:` mapping | `tasks:` with `requires:` / `provides:` arrays |
| **Who decides next?** | The sender (current step's result picks the transition) | The receivers (tasks become eligible when their required tokens appear) |
| **Has a driver?** | Yes — `StepMachine` class runs the loop for you | No — you call `next()` and `apply()` yourself (or write a 10-line loop) |
| **Import** | `import { StepMachine } from 'yaml-flow/step-machine'` | `import { next, apply } from 'yaml-flow/event-graph'` |

### Use Step Machine when…

- Your workflow is a **known sequence** of steps with conditional branching.
- You need **pause/resume** built in.
- The work is conversational: receive input → process → decide next step → repeat.
- You want to hand the library a YAML file and some handler functions and call `.run()`.

**Examples:** form wizards, approval chains, AI chat loops, order processing pipelines, ETL with linear stages.

### Use Event Graph when…

- Tasks have **complex dependencies** — diamonds, fan-out, fan-in, optional paths.
- You don't know the execution order up front; it **emerges from the data**.
- Multiple tasks can run **in parallel** once their inputs are satisfied.
- You need **conflict resolution** when two tasks compete to produce the same output.
- Your system is **event-driven**: external events inject tokens that unblock downstream tasks.
- You want the engine to be a **pure function** you embed in your own scheduler, serverless function, or agent loop.

**Examples:** CI/CD pipelines, agent tool orchestration, research workflows (fetch → analyse A | analyse B → merge), build systems, multi-model AI routing, eligibility engines.

### When in doubt

Start with **Step Machine** if your workflow diagram is a straight line with branches.  
Start with **Event Graph** if your workflow diagram has diamonds or parallel lanes.

Both are pure `f(state, input) → newState` at their core. You can always call the reducer directly without the driver class.

---

## Step Machine — Quick Start

### 1. Define a flow

```yaml
# support-ticket.yaml
settings:
  start_step: classify
  max_total_steps: 20

steps:
  classify:
    produces_data: [category, priority]
    transitions:
      billing: handle_billing
      technical: handle_technical
      general: handle_general

  handle_billing:
    expects_data: [category]
    produces_data: [resolution]
    transitions:
      resolved: close_ticket
      escalate: escalate_ticket

  handle_technical:
    expects_data: [category]
    produces_data: [resolution]
    transitions:
      resolved: close_ticket
      escalate: escalate_ticket
    retry:
      max_attempts: 2
      delay_ms: 1000

  handle_general:
    expects_data: [category]
    produces_data: [resolution]
    transitions:
      resolved: close_ticket

  escalate_ticket:
    expects_data: [category, priority]
    produces_data: [escalation_id]
    transitions:
      done: close_ticket

terminal_states:
  close_ticket:
    return_intent: resolved
    return_artifacts: [resolution]
```

### 2. Write handlers and run

```typescript
import { createStepMachine, loadStepFlow } from 'yaml-flow/step-machine';
import { MemoryStore } from 'yaml-flow/stores/memory';

const flow = await loadStepFlow('./support-ticket.yaml');

const handlers = {
  classify: async (input) => {
    const category = detectCategory(input.message);
    return { result: category, data: { category, priority: 'high' } };
  },
  handle_billing: async (input, ctx) => {
    const answer = await ctx.components.ai.ask(`Billing issue: ${input.category}`);
    return { result: 'resolved', data: { resolution: answer } };
  },
  handle_technical: async (input, ctx) => {
    const answer = await ctx.components.ai.ask(`Tech issue: ${input.category}`);
    return answer.confidence > 0.7
      ? { result: 'resolved', data: { resolution: answer.text } }
      : { result: 'escalate' };
  },
  handle_general: async (input) => {
    return { result: 'resolved', data: { resolution: 'See FAQ.' } };
  },
  escalate_ticket: async (input, ctx) => {
    const id = await ctx.components.ticketSystem.escalate(input.category);
    return { result: 'done', data: { escalation_id: id } };
  },
};

const machine = createStepMachine(flow, handlers, {
  store: new MemoryStore(),
  components: { ai: myAIClient, ticketSystem: myTicketAPI },
});

const result = await machine.run({ message: 'I was double-charged' });
// result.intent  → 'resolved'
// result.data    → { resolution: '...' }
// result.stepHistory → ['classify', 'handle_billing']
```

### Step Machine features at a glance

| Feature | Config |
|---|---|
| Transitions | `transitions: { success: next_step, failure: error_step }` |
| Failure transitions | `failure_transitions: { failure: error_step, timeout: timeout_step }` |
| Retry | `retry: { max_attempts: 3, delay_ms: 1000, backoff_multiplier: 2 }` |
| Circuit breaker | `circuit_breaker: { max_iterations: 5, on_open: fallback }` |
| Pause / resume | `await machine.pause(runId)` / `await machine.resume(runId)` |
| Cancellation | Pass `signal: AbortController.signal` in options |
| Events | `machine.on('step:complete', fn)` — also `flow:start`, `flow:complete`, `transition`, etc. |
| Data flow | `expects_data` filters what a handler receives; `produces_data` documents what it returns |

### Using the pure reducer directly (no driver)

```typescript
import { createInitialState, applyStepResult, checkCircuitBreaker, computeStepInput } from 'yaml-flow/step-machine';

let state = createInitialState(flow, 'run-1');

// Your own loop
while (true) {
  const cb = checkCircuitBreaker(flow, state, state.currentStep);
  if (cb.broken) { state = cb.newState; continue; }
  state = cb.newState;

  const input = computeStepInput(flow, state.currentStep, allData);
  const stepResult = await handlers[state.currentStep](input, context);
  const { newState, isTerminal } = applyStepResult(flow, state, state.currentStep, stepResult);
  state = newState;
  if (isTerminal) break;
}
```

---

## Event Graph — Quick Start

The event graph has no driver class. You call two pure functions in a loop:

- **`next(graph, state)`** → tells you which tasks are eligible right now
- **`apply(state, event, graph)`** → applies an event and returns the new state

You decide how to actually execute the tasks (call an API, run a function, ask an LLM, etc.).

### 1. Define a graph

```yaml
# research-pipeline.yaml
settings:
  completion: goal-reached
  goal: [final-report]
  conflict_strategy: parallel-all

tasks:
  fetch_sources:
    provides: [raw-asources]

  analyse_sentiment:
    requires: [raw-asources]
    provides: [sentiment-result]

  analyse_entities:
    requires: [raw-asources]
    provides: [entity-result]

  merge_analysis:
    requires: [sentiment-result, entity-result]
    provides: [merged-analysis]

  generate_report:
    requires: [merged-analysis]
    provides: [final-report]
```

`fetch_sources` runs first (no requires). Once it completes, both `analyse_sentiment` and `analyse_entities` become eligible in parallel. `merge_analysis` waits for both. `generate_report` waits for the merge. Done when `final-report` appears.

### 2. Write a driver loop

```typescript
import { next, apply, createInitialExecutionState } from 'yaml-flow/event-graph';
import { parse } from 'yaml';
import { readFileSync } from 'fs';

const graph = parse(readFileSync('./research-pipeline.yaml', 'utf8'));
let state = createInitialExecutionState(graph, 'exec-1');

while (true) {
  const schedule = next(graph, state);

  if (schedule.isComplete) {
    console.log('Done!', state.availableOutputs);
    break;
  }
  if (schedule.stuckDetection.is_stuck) {
    console.error('Stuck:', schedule.stuckDetection.stuck_description);
    break;
  }

  // Execute all eligible tasks (in parallel)
  const results = await Promise.all(
    schedule.eligibleTasks.map(async (taskName) => {
      state = apply(state, { type: 'task-started', taskName, timestamp: new Date().toISOString() }, graph);

      try {
        const output = await executeTask(taskName, state);
        return { taskName, success: true, result: output };
      } catch (err) {
        return { taskName, success: false, error: err.message };
      }
    })
  );

  // Feed results back into the reducer
  for (const r of results) {
    if (r.success) {
      state = apply(state, { type: 'task-completed', taskName: r.taskName, result: r.result, timestamp: new Date().toISOString() }, graph);
    } else {
      state = apply(state, { type: 'task-failed', taskName: r.taskName, error: r.error, timestamp: new Date().toISOString() }, graph);
    }
  }
}
```

That's the entire integration. ~30 lines. The engine is pure; your loop owns the I/O.

### Event Graph features at a glance

| Feature | Config | What it does |
|---|---|---|
| Dependencies | `requires: [a, b]` / `provides: [c]` | Task runs when all required tokens are available |
| Conditional routing | `on: { positive: [pos-result], negative: [neg-result] }` | Different outputs based on task result |
| Failure tokens | `on_failure: [data-unavailable]` | Inject tokens on failure so downstream alternatives can activate |
| Retry | `retry: { max_attempts: 3 }` | Auto-retry on failure (task resets to not-started) |
| Refresh strategy | `refreshStrategy: 'data-changed'` (default) | When a completed task should re-run: `data-changed`, `epoch-changed`, `time-based`, `manual`, `once` |
| Max executions | `maxExecutions: 5` | Cap how many times a task can execute |
| Refresh interval | `refreshInterval: 300` | Seconds between re-runs (for `time-based` strategy) |
| Circuit breaker | `circuit_breaker: { max_executions: 10, on_break: [stop-token] }` | Inject tokens after N executions |
| External events | `apply(state, { type: 'inject-tokens', tokens: ['user-approved'] })` | Unblock tasks waiting on external input |
| Dynamic tasks | `apply(state, { type: 'task-creation', taskName: 'new', taskConfig: {...} })` | Add tasks at runtime |
| Completion strategies | `completion: all-tasks-done \| all-outputs-done \| goal-reached \| manual` | When is the graph "done"? |
| Conflict resolution | `conflict_strategy: alphabetical \| priority-first \| parallel-all \| ...` | What happens when two tasks produce the same output? |
| Stuck detection | Automatic via `next()` | Returns `is_stuck: true` with description when no progress is possible |

### Completion strategies explained

| Strategy | Meaning |
|---|---|
| `all-tasks-done` | Every task has completed (or failed/inactivated) |
| `all-outputs-done` | Every `provides` token from every task is available |
| `goal-reached` | Specific tokens listed in `settings.goal` are available |
| `only-resolved` | All non-failed tasks have completed |
| `manual` | Never auto-completes; you decide when to stop |

### Conflict resolution strategies

When multiple eligible tasks produce the same output token, only one should run (unless you want parallel-all). The `conflict_strategy` setting controls the selection:

| Strategy | Behaviour |
|---|---|
| `alphabetical` | Pick the alphabetically first task name (default, deterministic) |
| `priority-first` | Pick the task with the highest `priority` value |
| `duration-first` | Pick the task with the lowest `estimatedDuration` |
| `cost-optimized` | Pick the task with the lowest `estimatedCost` |
| `resource-aware` | Pick the task with the lowest total resource requirements |
| `round-robin` | Rotate among competing tasks across scheduler calls |
| `random-select` | Pick one at random |
| `parallel-all` | Run all competing tasks (no conflict resolution) |
| `user-choice` | Return all candidates; let the caller decide |
| `skip-conflicts` | Skip all tasks involved in a conflict |

---

## Practical Patterns

### Pattern: AI Agent Tool Orchestration (Event Graph)

An agent needs to gather evidence from multiple source_defs, then synthesize.

```yaml
settings:
  completion: goal-reached
  goal: [final-answer]
  conflict_strategy: parallel-all

tasks:
  search_web:
    provides: [web-results]
  search_database:
    provides: [db-results]
  search_documents:
    provides: [doc-results]

  synthesize:
    requires: [web-results, db-results, doc-results]
    provides: [draft-answer]

  verify:
    requires: [draft-answer]
    provides: [final-answer]
    on:
      verified: [final-answer]
      rejected: [needs-revision]
    on_failure: [verification-skipped]

  revise:
    requires: [needs-revision]
    provides: [draft-answer]
    refreshStrategy: epoch-changed
    maxExecutions: 3
```

The three searches run in parallel. `synthesize` waits for all three. `verify` can produce different token sets depending on its result. If rejected, `revise` picks up and feeds back into `verify` (up to 3 times). If verify itself fails, `verification-skipped` unblocks any downstream task waiting on it.

### Refresh Strategies

| Strategy | Behavior |
|---|---|
| `data-changed` (default) | Re-run when upstream output content changes (tracked via `dataHash`) |
| `epoch-changed` | Re-run when upstream task execution count increases (classic "inputs refreshed") |
| `time-based` | Re-run after `refreshInterval` seconds since last completion |
| `manual` | Never auto-eligible; only via external `inject-tokens` or explicit push |
| `once` | Run once, never re-run (classic one-shot task) |

Set a board-level default in `settings.refreshStrategy`, then override per-task:

```yaml
settings:
  completion: manual
  refreshStrategy: epoch-changed   # board default
tasks:
  fetch_prices:
    provides: [price-data]
    refreshStrategy: time-based     # override: poll every 60s
    refreshInterval: 60
  compute:
    requires: [price-data]
    provides: [indicators]
    # inherits epoch-changed from settings
  alert:
    requires: [indicators]
    provides: [alert-sent]
    refreshStrategy: data-changed   # override: only if indicators actually changed
    maxExecutions: 10               # safety cap
```

Handlers can return a `dataHash` with completion events to enable content-aware freshness:

```typescript
apply(state, {
  type: 'task-completed',
  taskName: 'fetch_prices',
  dataHash: crypto.createHash('md5').update(JSON.stringify(data)).digest('hex'),
  timestamp: new Date().toISOString(),
}, graph);
```

### Pattern: Order Processing Pipeline (Step Machine)

```yaml
settings:
  start_step: validate
  max_total_steps: 15

steps:
  validate:
    produces_data: [validated_order]
    transitions:
      valid: charge_payment
      invalid: reject

  charge_payment:
    expects_data: [validated_order]
    produces_data: [payment_id]
    transitions:
      success: ship
      declined: reject
    retry:
      max_attempts: 3
      delay_ms: 2000
      backoff_multiplier: 2

  ship:
    expects_data: [validated_order, payment_id]
    produces_data: [tracking_number]
    transitions:
      shipped: confirm
      failure: refund

  refund:
    expects_data: [payment_id]
    produces_data: [refund_id]
    transitions:
      done: reject

  confirm:
    expects_data: [tracking_number]
    transitions:
      done: complete

terminal_states:
  complete:
    return_intent: success
    return_artifacts: [tracking_number, payment_id]
  reject:
    return_intent: rejected
    return_artifacts: false
```

Linear with branches. The current step decides what's next. Retry on payment failures with exponential backoff.

### Pattern: Inject External Events (Event Graph)

```typescript
// A task is waiting for human approval
const graph = {
  settings: { completion: 'goal-reached', goal: ['deployed'] },
  tasks: {
    build:    { provides: ['build-artifact'] },
    test:     { requires: ['build-artifact'], provides: ['test-passed'] },
    approve:  { requires: ['test-passed', 'human-approval'], provides: ['approved'] },
    deploy:   { requires: ['approved'], provides: ['deployed'] },
  },
};

let state = createInitialExecutionState(graph, 'deploy-1');

// ... run build and test normally ...

// Later, when a human clicks "Approve" in your UI:
state = apply(state, {
  type: 'inject-tokens',
  tokens: ['human-approval'],
  timestamp: new Date().toISOString(),
}, graph);

// Now next(graph, state) will return 'approve' as eligible
```

### Pattern: Conditional Branching in Event Graph

```yaml
tasks:
  classify_image:
    provides: [classification]
    on:
      photo: [is-photo]
      document: [is-document]
      screenshot: [is-screenshot]

  enhance_photo:
    requires: [is-photo]
    provides: [processed-image]

  ocr_document:
    requires: [is-document]
    provides: [extracted-text]

  crop_screenshot:
    requires: [is-screenshot]
    provides: [processed-image]
```

Only one downstream path activates based on the classifier result. This is the event-graph equivalent of a switch statement.

---

## Storage Adapters

All three stores work with both modes. Step Machine uses them for run state persistence. Event Graph state is plain JSON — serialize it yourself or use a store.

### Memory (default, all environments)

```typescript
import { MemoryStore } from 'yaml-flow/stores/memory';
```

### LocalStorage (browser)

```typescript
import { LocalStorageStore } from 'yaml-flow/stores/localStorage';
new LocalStorageStore({ prefix: 'myapp' });
```

### File System (Node.js)

```typescript
import { FileStore } from 'yaml-flow/stores/file';
new FileStore({ directory: './flow-data' });
```

### Custom Store

Implement the `StepMachineStore` interface:

```typescript
interface StepMachineStore {
  saveRunState(runId: string, state: StepMachineState): Promise<void>;
  loadRunState(runId: string): Promise<StepMachineState | null>;
  deleteRunState(runId: string): Promise<void>;
  setData(runId: string, key: string, value: unknown): Promise<void>;
  getData(runId: string, key: string): Promise<unknown>;
  getAllData(runId: string): Promise<Record<string, unknown>>;
  clearData(runId: string): Promise<void>;
}
```

---

## Batch Processing

yaml-flow includes a `batch()` utility for running multiple items through a flow concurrently. It works with both Step Machine and Event Graph — you provide the processor, it manages concurrency.

### Quick Start

```typescript
import { batch } from 'yaml-flow/batch';
import { createStepMachine } from 'yaml-flow/step-machine';

const tickets = [
  { id: 'T-001', message: 'Billing error' },
  { id: 'T-002', message: 'App crashes on login' },
  { id: 'T-003', message: 'Password reset help' },
];

const result = await batch(tickets, {
  concurrency: 3,
  processor: async (ticket) => {
    const machine = createStepMachine(flow, handlers);
    return machine.run({ message: ticket.message });
  },
  onProgress: (p) => console.log(`${p.percent}% done`),
});

console.log(`${result.completed} succeeded, ${result.failed} failed`);
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | `number` | `5` | Max parallel processors |
| `processor` | `(item, index) => Promise<TResult>` | *required* | Async function to process each item |
| `signal` | `AbortSignal` | — | Cancel remaining items |
| `onItemComplete` | `(item, result, index) => void` | — | Called when an item succeeds |
| `onItemError` | `(item, error, index) => void` | — | Called when an item fails |
| `onProgress` | `(progress) => void` | — | Called after each item with `{ completed, failed, active, pending, total, percent, elapsedMs }` |

### Result Shape

```typescript
{
  items: BatchItemResult[];  // Per-item: { item, index, status, result?, error?, durationMs }
  completed: number;         // Items that succeeded
  failed: number;            // Items that threw
  total: number;
  durationMs: number;        // Wall-clock time for entire batch
}
```

### Works with Event Graph too

```typescript
import { batch } from 'yaml-flow/batch';
import { next, apply, createInitialExecutionState } from 'yaml-flow/event-graph';

const result = await batch(items, {
  concurrency: 5,
  processor: async (item) => {
    let state = createInitialExecutionState(graph, `run-${item.id}`);
    state = apply(state, { type: 'inject-tokens', tokens: [item.readyToken], timestamp: Date.now() }, graph);
    // ... drive graph loop with next() + apply()
    return state;
  },
});
```

---

## Config Utilities

Pure pre-processing transforms you apply before passing config to the engine. They never touch engine state — just config in, config out.

### Variable Interpolation

Replace `${KEY}` patterns in any config object. Works with both GraphConfig and StepFlowConfig.

```typescript
import { resolveVariables } from 'yaml-flow/config';

const resolved = resolveVariables(graphConfig, {
  ENTITY_ID: 'ticket-42',
  TOOLS_DIR: '/opt/tools',
  WORKDIR: '/data/workdata',
});
// Every ${ENTITY_ID} in task configs, cmd-args, etc. → replaced
```

### Config Templates

DRY reusable config blocks. Tasks reference a named template via `config-template`; the function deep-merges template + task overrides and removes the reference.

```typescript
import { resolveConfigTemplates } from 'yaml-flow/config';

const config = {
  configTemplates: {                              // or 'config-templates' (kebab-case)
    PYTHON_TOOL: { cmd: 'python', timeout: 30000, cwd: '/workdata' },
    NODE_CMD:    { cmd: 'node',   timeout: 60000 },
  },
  tasks: {
    analyze:  { provides: ['analysis'], config: { 'config-template': 'PYTHON_TOOL', 'cmd-args': 'analyze.py' } },
    build:    { provides: ['build'],    config: { 'config-template': 'NODE_CMD',    script: 'build.js' } },
  },
};

const resolved = resolveConfigTemplates(config);
// analyze.config → { cmd: 'python', timeout: 30000, cwd: '/workdata', 'cmd-args': 'analyze.py' }
// configTemplates key removed from output
```

### Composing Both

Templates first (expands references), then variables (fills in `${...}` placeholders):

```typescript
import { resolveConfigTemplates, resolveVariables } from 'yaml-flow/config';

const raw = loadYaml('pipeline.yaml');                  // has configTemplates + ${VAR} refs
const resolved = resolveVariables(
  resolveConfigTemplates(raw),
  { ENTITY_ID: 'url-42', TOOLS_DIR: '/opt/tools' },
);
```

---

## Graph-of-Graphs Pattern

Real-world pipelines are often **layered**: an outer orchestration graph where some tasks are themselves entire sub-workflows — each processing a batch of items through their own DAG or step flow. yaml-flow doesn't bake this into the engine (the pure scheduler stays simple), but the primitives compose cleanly.

### The Shape

```
Outer graph (event-graph)
├── prep-workdata          → plain task
├── copy-input-files       → plain task
├── evidence-gathering     → batch × inner event-graph (N items, 5 concurrent)
├── grade-synthesis        → batch × inner step-machine (N items, 3 concurrent)
├── analyze-mismatches     → plain task
├── [health-check ∥ report]→ parallel plain tasks
└── archive-results        → waits for both
```

The outer graph sequences coarse stages. Some stages fan out into batches where each item runs through its own sub-workflow. The sub can be either mode.

### How to Wire It

Each "sub-graph task" in the outer graph is just a handler that composes `resolveConfigTemplates` → `resolveVariables` → `batch` → engine:

```typescript
import { next, apply, createInitialExecutionState } from 'yaml-flow/event-graph';
import { createStepMachine } from 'yaml-flow/step-machine';
import { batch } from 'yaml-flow/batch';
import { resolveVariables, resolveConfigTemplates } from 'yaml-flow/config';

// Outer graph handler for a sub-graph task (event-graph sub)
async function runEvidenceBatch(items, rawSubConfig) {
  return batch(items, {
    concurrency: 5,
    processor: async (item) => {
      // Resolve config per-item (each item gets its own ENTITY_ID)
      const config = resolveVariables(
        resolveConfigTemplates(rawSubConfig),
        { ENTITY_ID: item.id, TOOLS_DIR: '/opt/tools' },
      );
      // Drive the inner event-graph
      let state = createInitialExecutionState(config, `run-${item.id}`);
      while (true) {
        const { eligibleTasks, isComplete } = next(config, state);
        if (isComplete) break;
        for (const task of eligibleTasks) {
          state = apply(state, { type: 'task-started', taskName: task, timestamp: new Date().toISOString() }, config);
          const result = await executeTask(task, config.tasks[task], item);
          state = apply(state, { type: 'task-completed', taskName: task, result, timestamp: new Date().toISOString() }, config);
        }
      }
      return state;
    },
  });
}

// Outer graph handler for a sub-graph task (step-machine sub)
async function runGradeBatch(items, flowConfig, handlers) {
  return batch(items, {
    concurrency: 3,
    processor: async (item) => {
      const machine = createStepMachine(flowConfig, handlers);
      return machine.run({ entityId: item.id, evidence: item.evidence });
    },
  });
}
```

### Driving the Outer Graph

The outer graph itself is an event-graph. Each handler maps to a task:

```typescript
const outerHandlers = {
  'prep-workdata':     async () => { /* setup */ },
  'copy-input-files':  async () => { /* parse CSV, return items */ },
  'evidence-batch':    async (ctx) => runEvidenceBatch(ctx.items, evidenceConfig),
  'grade-batch':       async (ctx) => runGradeBatch(ctx.items, gradeFlow, gradeHandlers),
  'analyze-mismatches':async (ctx) => { /* compare grades */ },
  'health-check':      async (ctx) => { /* validate */ },
  'generate-report':   async (ctx) => { /* summarize */ },
  'archive':           async (ctx) => { /* move outputs */ },
};

// Simple outer loop
let state = createInitialExecutionState(outerGraph, 'pipeline-run-1');
while (true) {
  const { eligibleTasks, isComplete } = next(outerGraph, state);
  if (isComplete) break;
  await Promise.all(eligibleTasks.map(async (taskName) => {
    state = apply(state, { type: 'task-started', taskName, timestamp: now() }, outerGraph);
    try {
      await outerHandlers[taskName](context);
      state = apply(state, { type: 'task-completed', taskName, timestamp: now() }, outerGraph);
    } catch (err) {
      state = apply(state, { type: 'task-failed', taskName, error: err.message, timestamp: now() }, outerGraph);
    }
  }));
}
```

### Why Not Bake It Into the Engine?

- The pure scheduler (`next`/`apply`) stays a simple `f(state, event) → newState`.
- Sub-graph execution involves file I/O, process spawning, HTTP calls — all driver concerns.
- Every deployment customizes how sub-tasks execute: in-process, `execSync`, HTTP, serverless.
- The primitives (`batch` + `resolveVariables` + `resolveConfigTemplates` + both engines) compose without coupling.

See the [examples/npm-libs/graph-of-graphs/](./examples/npm-libs/graph-of-graphs/) directory for complete runnable examples.

---

## Execution Plan (Dry Run)

Compute the full execution plan from a graph config without running anything — like `terraform plan` for workflows.

```typescript
import { planExecution } from 'yaml-flow/event-graph';

const plan = planExecution(graph);

plan.phases;          // [['prep'], ['copy'], ['evidence'], ['synthesis'], ['analyze'], ['health', 'report'], ['archive']]
plan.depth;           // 7
plan.maxParallelism;  // 2
plan.entryPoints;     // ['prep']
plan.leafTasks;       // ['archive']
plan.conflicts;       // { 'output-token': ['task-a', 'task-b'] }  — multiple producers
plan.unreachableTokens; // ['human-approval']  — required but no task produces it
plan.blockedTasks;    // ['approve']  — blocked by unreachable tokens
plan.dependencies;    // { 'copy': ['prep'], 'evidence': ['copy'], ... }
```

---

## Mermaid Diagrams

Generate Mermaid syntax from any config — useful for docs, debugging, and CI reports.

```typescript
import { graphToMermaid, flowToMermaid } from 'yaml-flow/event-graph';

// Event graph → dependency diagram
console.log(graphToMermaid(graph));
// graph TD
//   build([build])
//   test[test]
//   deploy[[deploy]]
//   build -->|artifact| test
//   test -->|tested| deploy

// Step machine → flowchart
console.log(flowToMermaid(flow));
// graph TD
//   START(( ))
//   START --> classify
//   classify -->|billing| handle
//   handle -->|resolved| done
//   done([done: resolved])
```

Options: `{ direction: 'LR' | 'TD', showTokens: boolean, title: string }`.  
Entry points (no requires) get rounded shapes, leaf tasks get double-bracketed shapes, unreachable deps get warning markers.

---

## Graph Validation (Semantic)

Validate the logical correctness of a graph — catches issues that structural validation (`validateGraphConfig`) can't.

```typescript
import { validateGraph } from 'yaml-flow/event-graph';

const result = validateGraph(graph);

result.valid;     // true if no errors (warnings/info allowed)
result.errors;    // issues that will break execution
result.warnings;  // issues that may cause unexpected behavior
result.issues;    // all issues (errors + warnings + info)

// Each issue
result.issues[0].severity; // 'error' | 'warning' | 'info'
result.issues[0].code;     // e.g. 'CIRCULAR_DEPENDENCY'
result.issues[0].message;  // human-readable description
result.issues[0].tasks;    // affected task names
result.issues[0].tokens;   // affected tokens
```

| Issue Code | Severity | Description |
|---|---|---|
| `EMPTY_GRAPH` | error | Graph has no tasks |
| `DANGLING_REQUIRES` | error | Task requires a token that no task produces |
| `CIRCULAR_DEPENDENCY` | error | Cycle detected in task dependencies |
| `SELF_DEPENDENCY` | error | Task requires a token it provides itself |
| `UNREACHABLE_GOAL` | error | Goal token cannot be produced by any task |
| `MISSING_GOAL` | error | `goal-reached` strategy without goal array |
| `PROVIDE_CONFLICT` | warning | Multiple tasks produce the same token |
| `DEAD_END_TASK` | warning | Task has no provides — can't unblock downstream |
| `ISOLATED_TASK` | info | Disconnected task with no requires or dependents |

Use `validateGraphConfig()` for structural checks (JSON shape) and `validateGraph()` for semantic checks (logical correctness). Both are pure functions.

---

## JSON Schema Validation

Full structural validation using AJV against the JSON Schema definitions. Catches malformed configs before they reach the engine.

```typescript
import { validateGraphSchema } from 'yaml-flow/event-graph';
import { validateFlowSchema } from 'yaml-flow/step-machine';
import { validateLiveCardSchema } from 'yaml-flow/card-compute';

// Event graph
const r1 = validateGraphSchema(config);
r1.ok;      // true | false
r1.errors;  // AJV error objects (when invalid)

// Step machine
const r2 = validateFlowSchema(config);

// Live cards
const r3 = validateLiveCardSchema(config);
```

| Validator | Schema file | What it checks |
|---|---|---|
| `validateGraphSchema` | `schema/event-graph.schema.json` | Tasks, settings, refreshStrategy, retry, circuit_breaker, inference hints |
| `validateFlowSchema` | `schema/flow.schema.json` | Steps, transitions, retry, terminal states |
| `validateLiveCardSchema` | `schema/live-cards.schema.json` | Cards, source_defs, elements, compute, data bindings |

All validators are synchronous, pure functions. They return `{ ok: boolean, errors?: ErrorObject[] }`.

---

## Continuous Event Graph

A **long-lived, evolving** event-graph where both the graph config and execution state mutate over time. Ideal for dashboards, monitoring systems, and any scenario where the workflow has no fixed endpoint.

The core type is `LiveGraph` — it bundles `config` + `state` so they can't get out of sync. Every function is pure: `f(LiveGraph, input) → LiveGraph`.

```typescript
import {
  createLiveGraph, applyEvent,
  addNode, removeNode,
  addRequires, removeRequires, addProvides, removeProvides,
  injectTokens, drainTokens,
  schedule, inspect,
  resetNode, disableNode, enableNode, getNode,
  snapshot, restore,
  getUnreachableTokens, getUnreachableNodes,
  getUpstream, getDownstream,
} from 'yaml-flow/continuous-event-graph';
```

### Quick Start

```typescript
import { createLiveGraph, applyEvent, addNode, schedule, inspect } from 'yaml-flow/continuous-event-graph';

// 1. Bootstrap
let live = createLiveGraph({
  settings: { completion: 'manual' },
  tasks: {
    fetch_prices: { provides: ['price-data'] },
    compute:      { requires: ['price-data'], provides: ['indicators'] },
  },
});

// 2. Schedule — what's ready?
schedule(live).eligible;  // ['fetch_prices']

// 3. Apply events — immutable state transitions
live = applyEvent(live, { type: 'task-started', taskName: 'fetch_prices', timestamp: new Date().toISOString() });
live = applyEvent(live, { type: 'task-completed', taskName: 'fetch_prices', timestamp: new Date().toISOString() });
schedule(live).eligible;  // ['compute']

// 4. Evolve — add a node at runtime
live = addNode(live, 'alert', { requires: ['indicators'], provides: ['alert-sent'] });

// 5. Health check
inspect(live);  // { totalNodes: 3, running: 0, completed: 1, ... }
```

### Graph Mutations

| Function | Description |
|---|---|
| `addNode(live, name, config)` | Add a task to the graph (config + state) |
| `removeNode(live, name)` | Remove a task from the graph |
| `addRequires(live, node, tokens)` | Add requires tokens to a node |
| `removeRequires(live, node, tokens)` | Remove requires tokens from a node |
| `addProvides(live, node, tokens)` | Add provides tokens to a node |
| `removeProvides(live, node, tokens)` | Remove provides tokens from a node |

### Token Management

```typescript
// Inject external data/signals
live = injectTokens(live, ['market-open', 'price-data']);

// Drain stale/expired tokens
live = drainTokens(live, ['price-data']);  // forces re-fetch before downstream can run
```

### Node Lifecycle

| Function | Description |
|---|---|
| `resetNode(live, name)` | Reset a node to `not-started` (for retry) |
| `disableNode(live, name)` | Set a node to `inactivated` (scheduler skips it) |
| `enableNode(live, name)` | Re-enable a disabled node |
| `getNode(live, name)` | Get config + state for a single node |

### Graph Traversal

```typescript
// "What feeds into generate_signals?"
const upstream = getUpstream(live, 'generate_signals');
upstream.nodes;   // [{ nodeName: 'fetch_prices', providesTokens: ['price-data'] }, ...]
upstream.tokens;  // ['price-data', 'indicators', ...]

// "What breaks if fetch_prices goes down?"
const downstream = getDownstream(live, 'fetch_prices');
downstream.nodes;   // [{ nodeName: 'compute', requiresTokens: ['price-data'] }, ...]
downstream.tokens;  // ['price-data', 'indicators', ...]
```

### Reachability Analysis

```typescript
// Tokens that can never be produced given the current state
const unreachableTokens = getUnreachableTokens(live);
unreachableTokens.tokens;  // [{ token: 'ghost', reason: 'no-producer', producers: [] }]

// Nodes that can never become eligible
const unreachableNodes = getUnreachableNodes(live);
unreachableNodes.nodes;  // [{ nodeName: 'orphan', missingTokens: ['ghost'] }]
```

### Persistence

```typescript
// Save
const snap = snapshot(live);        // JSON-safe object
localStorage.setItem('graph', JSON.stringify(snap));

// Restore
const data = JSON.parse(localStorage.getItem('graph')!);
const restored = restore(data);     // → LiveGraph (validates shape)
```

### Continuous Event Graph API Reference

| Function | Description |
|---|---|
| `createLiveGraph(config, id?)` | Bootstrap a LiveGraph from a GraphConfig |
| `applyEvent(live, event)` | Apply an execution event (task-started, task-completed, etc.) |
| `addNode(live, name, config)` | Add a node (both config + state) |
| `removeNode(live, name)` | Remove a node |
| `addRequires / removeRequires` | Wire/unwire requires tokens |
| `addProvides / removeProvides` | Wire/unwire provides tokens |
| `injectTokens(live, tokens)` | Add tokens to available outputs |
| `drainTokens(live, tokens)` | Remove tokens from available outputs |
| `schedule(live)` | Classify tasks: eligible / pending / unresolved / blocked / conflicts |
| `inspect(live)` | Health report: statuses, cycles, open deps, conflicts |
| `resetNode(live, name)` | Reset node to not-started |
| `disableNode(live, name)` | Disable a node (inactivated) |
| `enableNode(live, name)` | Re-enable a disabled node |
| `getNode(live, name)` | Get a node's config + state |
| `getUpstream(live, name)` | Transitive upstream: what feeds into this node? |
| `getDownstream(live, name)` | Transitive downstream: what depends on this node? |
| `getUnreachableTokens(live)` | Tokens that can never be produced |
| `getUnreachableNodes(live)` | Nodes that can never become eligible |
| `snapshot(live)` | Serialize to a JSON-safe snapshot |
| `restore(data)` | Restore a LiveGraph from a snapshot |
| `applyEvents(live, events)` | Apply multiple events atomically (batch reduce) |

### Reactive Graph (Push-based Execution)

The reactive layer adds **self-sustaining execution** on top of the pure LiveGraph. Register handlers, push one event, and the graph drives itself to completion. No daemon, no polling — each handler callback triggers the next wave.

```typescript
import { createReactiveGraph, MemoryJournal } from 'yaml-flow/continuous-event-graph';

// 1. Create with handlers
const rg = createReactiveGraph(config, {
  handlers: {
    fetch:     async ({ callbackToken }) => { /* ... */ return 'task-initiated'; },
    transform: async ({ callbackToken }) => { /* ... */ return 'task-initiated'; },
    notify:    async ({ callbackToken }) => { /* ... */ return 'task-initiated'; },
  },
  onDrain: (events, live, schedule) => console.log(`${events.length} events, ${schedule.eligible.length} eligible`),
});

// 2. Push one event — the chain sustains itself
rg.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
// fetch runs -> completes -> transform becomes eligible -> runs -> notify -> done

// 3. Add nodes at runtime
rg.addNode('alert', { requires: ['anomaly'], provides: ['alerted'], taskHandlers: ['alert'] });
rg.registerHandler('alert', async ({ callbackToken }) => {
  // ... do work, then resolve the callback
  rg.resolveCallback(callbackToken, { alerted: true });
  return 'task-initiated';
});

// 4. Dynamic wiring mutations
rg.addRequires('alert', ['sentiment']);      // add a new dependency
rg.removeRequires('alert', ['sentiment']);   // detach it
rg.addProvides('fetch', ['market-data']);    // produce a new token
rg.removeProvides('fetch', ['market-data']); // stop producing it

// 5. Batch events + selective retrigger
rg.pushAll([event1, event2]);               // atomic multi-event push
rg.retrigger('fetch');                       // re-run a single task
rg.retriggerAll(['fetch', 'transform']);     // re-run multiple tasks

// 6. Read state
rg.getState();          // LiveGraph snapshot
rg.getSchedule();       // current ScheduleResult

// 7. Cleanup
rg.dispose();
```

**How it works internally:**

```
push(event)
  -> applyEvent (pure state change)
  -> schedule (what's eligible?)
  -> dispatch handlers (fire-and-forget)
  -> handler completes -> appends to journal
  -> drain journal -> applyEvents (batch) -> schedule -> dispatch
  -> repeat until nothing is eligible
```

The journal serializes concurrent callbacks — multiple handlers complete simultaneously, their events batch into a single `applyEvents()` call. No race conditions.

**Handler model:** Handlers are initiators. They receive a `callbackToken` and return `'task-initiated'` or `'task-initiate-failure'`. When work completes, call `rg.resolveCallback(token, data, errors?)` to push the result back through the engine.

**ReactiveGraph API:**

| Method | Description |
|---|---|
| `push(event)` | Push a single event into the engine |
| `pushAll(events)` | Push multiple events atomically |
| `resolveCallback(token, data, errors?)` | Resolve a handler's callback token |
| `addNode(name, config)` | Add a task to the live graph |
| `removeNode(name)` | Remove a task from the live graph |
| `addRequires(name, tokens)` | Add require tokens to a task |
| `removeRequires(name, tokens)` | Remove require tokens from a task |
| `addProvides(name, tokens)` | Add provide tokens to a task |
| `removeProvides(name, tokens)` | Remove provide tokens from a task |
| `registerHandler(name, fn)` | Register a named handler |
| `unregisterHandler(name)` | Unregister a handler |
| `retrigger(name)` | Reset and re-run a single task |
| `retriggerAll(names)` | Reset and re-run multiple tasks |
| `getState()` | Current LiveGraph snapshot |
| `getSchedule()` | Current ScheduleResult |
| `dispose()` | Shut down the reactive graph |

**Options:**

| Option | Default | Description |
|---|---|---|
| `handlers` | (required) | `Record<string, TaskHandlerFn>` |
| `journal` | `MemoryJournal` | Event log adapter (`MemoryJournal` or `FileJournal`) |
| `onDrain` | — | Called after each drain cycle (observability) |

---

## LLM Inference

Pluggable AI-assisted completion detection. The caller provides the LLM via an `InferenceAdapter` — yaml-flow builds the prompt, parses the response, and applies the results. Core stays pure; inference is opt-in.

```typescript
import {
  buildInferencePrompt, inferCompletions, applyInferences, inferAndApply,
} from 'yaml-flow/inference';
```

### Inference Hints on Nodes

Add optional `inference` metadata to any `TaskConfig`:

```typescript
const config = {
  settings: { completion: 'all-tasks' },
  tasks: {
    'infra-provisioned': {
      provides: ['infra-ready'],
      inference: {
        criteria: 'All Azure resources provisioned successfully',
        keywords: ['azure', 'deployment', 'provisioning'],
        suggestedChecks: ['scan logs for "Deployment Succeeded"'],
        autoDetectable: true,   // LLM will analyze this node
      },
    },
    'app-deployed': {
      requires: ['infra-ready'],
      provides: ['app-ready'],
      inference: {
        criteria: 'Health check returns HTTP 200',
        autoDetectable: true,
      },
    },
    'monitoring': {                         // no inference → LLM skips it
      requires: ['app-ready'],
      provides: ['monitored'],
    },
  },
};
```

### Pluggable Adapter

Implement one method — `analyze(prompt) → string`:

```typescript
import type { InferenceAdapter } from 'yaml-flow/inference';

// OpenAI
const openaiAdapter: InferenceAdapter = {
  analyze: async (prompt) => {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o', messages: [{ role: 'user', content: prompt }],
    });
    return res.choices[0].message.content ?? '[]';
  },
};

// Anthropic
const claudeAdapter: InferenceAdapter = {
  analyze: async (prompt) => {
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    return res.content[0].type === 'text' ? res.content[0].text : '[]';
  },
};

// Any HTTP endpoint
const customAdapter: InferenceAdapter = {
  analyze: async (prompt) => {
    const res = await fetch('https://my-llm/analyze', {
      method: 'POST', body: JSON.stringify({ prompt }),
    });
    return (await res.json()).response;
  },
};
```

### Built-in Adapter Factories

Zero-boilerplate adapters for common patterns:

```typescript
import { createCliAdapter, createHttpAdapter } from 'yaml-flow/inference';

// Ollama via HTTP
const ollama = createHttpAdapter({
  url: 'http://localhost:11434/api/generate',
  buildBody: (prompt) => ({ model: 'llama3', prompt, stream: false }),
  extractResponse: (json) => json.response,
});

// Ollama via CLI
const ollamaCli = createCliAdapter({
  command: 'ollama',
  args: (prompt) => ['run', 'llama3', prompt],
});

// Simon Willison's llm CLI (stdin mode for long prompts)
const llm = createCliAdapter({
  command: 'llm',
  args: () => ['--no-stream'],
  stdin: true,
});

// Custom Python script
const custom = createCliAdapter({
  command: 'python',
  args: (prompt) => ['scripts/infer.py', '--json', prompt],
  cwd: '/path/to/project',
  env: { MODEL: 'gpt-4o' },
  timeout: 60_000,
});
```

**`createCliAdapter(options)`** — spawns a child process, captures stdout:
| Option | Type | Description |
|--------|------|-------------|
| `command` | `string` | Executable to run (`ollama`, `llm`, `python`, `gh`, …) |
| `args` | `(prompt) => string[]` | Build argument list from the prompt |
| `stdin` | `boolean` | Pipe prompt via stdin instead of args (default: `false`) |
| `timeout` | `number` | Kill after N ms (default: `30000`) |
| `cwd` | `string` | Working directory |
| `env` | `Record<string, string>` | Extra environment variables |

**`createHttpAdapter(options)`** — POSTs to an HTTP endpoint:
| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | Endpoint URL |
| `headers` | `Record<string, string>` | Request headers |
| `buildBody` | `(prompt) => object` | Build request body (default: `{ prompt }`) |
| `extractResponse` | `(json) => string` | Extract text from response JSON |
| `timeout` | `number` | Abort after N ms (default: `30000`) |
```

### Three APIs: Build → Suggest → Apply

```typescript
import { createLiveGraph } from 'yaml-flow/continuous-event-graph';
import { buildInferencePrompt, inferCompletions, applyInferences } from 'yaml-flow/inference';

let live = createLiveGraph(config);

// 1. BUILD: Generate the prompt (pure, sync)
const prompt = buildInferencePrompt(live, {
  context: 'Deployment log: "Deployment Succeeded", health check: HTTP 200',
});

// 2. SUGGEST: Ask the LLM (async)
const result = await inferCompletions(live, adapter, {
  threshold: 0.8,
  context: 'Deployment log: ...',
});
result.suggestions;  // [{ taskName, confidence, reasoning, detectionMethod }]

// 3. APPLY: Accept high-confidence suggestions (pure, sync)
live = applyInferences(live, result, 0.8);  // only applies >= 80% confidence
```

### One-Shot Convenience

```typescript
import { inferAndApply } from 'yaml-flow/inference';

const { live: updated, applied, skipped, inference } = await inferAndApply(
  live, adapter, { threshold: 0.8, context: 'deployment logs...' }
);

console.log('Auto-completed:', applied.map(s => s.taskName));
console.log('Skipped (low confidence):', skipped.map(s => `${s.taskName} (${s.confidence})`));
```

### Inference API Reference

| Function | Description |
|---|---|
| `buildInferencePrompt(live, opts?)` | Build LLM prompt from graph state (pure, sync) |
| `inferCompletions(live, adapter, opts?)` | Ask LLM to suggest completions (async) |
| `applyInferences(live, result, threshold?)` | Apply suggestions above threshold (pure, sync) |
| `inferAndApply(live, adapter, opts?)` | Infer + apply in one step (async, convenience) |
| `createCliAdapter(opts)` | Factory: adapter that spawns a CLI command |
| `createHttpAdapter(opts)` | Factory: adapter that POSTs to an HTTP endpoint |

### Inference Types

| Type | Description |
|---|---|
| `InferenceAdapter` | `{ analyze(prompt: string): Promise<string> }` — pluggable LLM bridge |
| `InferenceHints` | `criteria`, `keywords`, `suggestedChecks`, `autoDetectable` on a TaskConfig |
| `InferenceOptions` | `threshold`, `scope`, `context`, `systemPrompt` |
| `InferenceResult` | `suggestions[]`, `promptUsed`, `rawResponse`, `analyzedNodes` |
| `InferredCompletion` | `taskName`, `confidence`, `reasoning`, `detectionMethod: 'llm-inferred'` |
| `InferAndApplyResult` | `live`, `inference`, `applied[]`, `skipped[]` |
| `CliAdapterOptions` | `command`, `args`, `stdin`, `timeout`, `cwd`, `env` |
| `HttpAdapterOptions` | `url`, `headers`, `buildBody`, `extractResponse`, `timeout` |

---

## Loading & Exporting Graph Configs

```typescript
import { loadGraphConfig, exportGraphConfig, exportGraphConfigToFile } from 'yaml-flow/event-graph';

// Load from file, URL, JSON string, or object (validates automatically)
const graph = await loadGraphConfig('./pipeline.yaml');
const graph2 = await loadGraphConfig('https://example.com/graph.json');

// Export to string
const json = exportGraphConfig(graph);                         // JSON (default)
const yaml = exportGraphConfig(graph, { format: 'yaml' });     // YAML

// Export to file (format auto-detected from extension)
await exportGraphConfigToFile(graph, './output/pipeline.yaml');
```

---

## Package Exports

```typescript
// Everything (both modes + stores + batch)
import { StepMachine, next, apply, MemoryStore, batch } from 'yaml-flow';

// Step Machine only
import { StepMachine, createStepMachine, loadStepFlow } from 'yaml-flow/step-machine';
import { applyStepResult, checkCircuitBreaker, createInitialState } from 'yaml-flow/step-machine';

// Event Graph only
import { next, apply, applyAll, getCandidateTasks } from 'yaml-flow/event-graph';
import { createInitialExecutionState, isExecutionComplete, detectStuckState } from 'yaml-flow/event-graph';
import { planExecution, graphToMermaid, flowToMermaid } from 'yaml-flow/event-graph';
import { loadGraphConfig, validateGraphConfig, exportGraphConfig } from 'yaml-flow/event-graph';
import { validateGraph } from 'yaml-flow/event-graph';
import { TASK_STATUS, COMPLETION_STRATEGIES, CONFLICT_STRATEGIES } from 'yaml-flow/event-graph';

// Stores
import { MemoryStore, LocalStorageStore, FileStore } from 'yaml-flow/stores';

// Batch
import { batch } from 'yaml-flow/batch';
import type { BatchOptions, BatchResult, BatchItemResult, BatchProgress } from 'yaml-flow/batch';

// Config utilities
import { resolveVariables, resolveConfigTemplates } from 'yaml-flow/config';

// Continuous Event Graph (long-lived evolving workflows)
import {
  createLiveGraph, applyEvent, applyEvents, addNode, removeNode,
  addRequires, removeRequires, addProvides, removeProvides,
  injectTokens, drainTokens, schedule, inspect,
  resetNode, disableNode, enableNode, getNode,
  snapshot, restore,
  getUnreachableTokens, getUnreachableNodes,
  getUpstream, getDownstream,
  createReactiveGraph, MemoryJournal, FileJournal,
} from 'yaml-flow/continuous-event-graph';
import type {
  ReactiveGraph, TaskHandler, TaskHandlerContext, TaskHandlerResult,
  DispatchEntry, Journal,
} from 'yaml-flow/continuous-event-graph';

// JSON Schema Validators
import { validateGraphSchema } from 'yaml-flow/event-graph';
import { validateFlowSchema } from 'yaml-flow/step-machine';
import { validateLiveCardSchema } from 'yaml-flow/card-compute';

// LLM Inference (AI-assisted completion detection)
import {
  buildInferencePrompt, inferCompletions, applyInferences, inferAndApply,
} from 'yaml-flow/inference';
import type { InferenceAdapter, InferenceResult, InferenceOptions } from 'yaml-flow/inference';

// Backward compatibility (v1 names → v2)
import { FlowEngine, createEngine } from 'yaml-flow';  // aliases for StepMachine, createStepMachine
```

---

## API Reference

### Step Machine

| Export | Description |
|---|---|
| `createStepMachine(flow, handlers, options?)` | Create and validate a StepMachine instance |
| `StepMachine.run(initialData?)` | Execute flow from start, returns `StepMachineResult` |
| `StepMachine.pause(runId)` | Pause a running flow |
| `StepMachine.resume(runId)` | Resume a paused flow |
| `StepMachine.on(event, listener)` | Subscribe to events (`step:start`, `step:complete`, `flow:complete`, `transition`, etc.) |
| `loadStepFlow(path)` | Load + validate a YAML/JSON flow file |
| `applyStepResult(flow, state, step, result)` | Pure reducer: apply a step result to state |
| `checkCircuitBreaker(flow, state, step)` | Pure: check/increment circuit breaker |
| `computeStepInput(flow, step, allData)` | Pure: filter data to what a step expects |
| `createInitialState(flow, runId)` | Pure: create starting state |

### Event Graph

| Export | Description |
|---|---|
| `next(graph, state)` | Pure scheduler: returns `{ eligibleTasks, isComplete, stuckDetection, conflicts }` |
| `apply(state, event, graph)` | Pure reducer: apply one event, returns new state |
| `applyAll(state, events, graph)` | Apply multiple events sequentially |
| `createInitialExecutionState(graph, executionId)` | Create starting state for a graph |
| `getCandidateTasks(graph, state)` | Low-level: just the eligible task list |
| `isExecutionComplete(graph, state)` | Check completion against configured strategy |
| `detectStuckState({graph, state, ...})` | Check if execution is stuck |
| `addDynamicTask(graph, name, config)` | Immutably add a task to a graph config |
| `planExecution(graph)` | Dry-run: compute phases, parallelism, conflicts, unreachable tokens |
| `graphToMermaid(graph, options?)` | Generate Mermaid dependency diagram from an event-graph |
| `flowToMermaid(flow, options?)` | Generate Mermaid flowchart from a step-machine |
| `loadGraphConfig(source)` | Load + validate a YAML/JSON/URL graph config |
| `validateGraphConfig(config)` | Validate a GraphConfig, returns error strings |
| `exportGraphConfig(config, options?)` | Export a GraphConfig to JSON or YAML string |
| `exportGraphConfigToFile(config, path)` | Export a GraphConfig to a file |
| `validateGraph(graph)` | Semantic validation: cycles, dangling requires, unreachable goals, conflicts |

### Event Types (for `apply()`)

| Event | Fields | Effect |
|---|---|---|
| `task-started` | `taskName` | Sets task status to `running` |
| `task-completed` | `taskName`, `result?` | Marks completed, adds `provides` tokens (or `on[result]` tokens) |
| `task-failed` | `taskName`, `error` | Retries or marks failed, injects `on_failure` tokens |
| `task-progress` | `taskName`, `message?`, `progress?` | Updates progress/messages |
| `inject-tokens` | `tokens[]` | Adds tokens to available outputs (unblocks waiting tasks) |
| `agent-action` | `action: start\|stop\|pause\|resume` | Controls execution lifecycle |
| `task-creation` | `taskName`, `taskConfig` | Adds a new task to execution state |

---

## Examples

See the [examples/](./examples) directory:

| Example | Mode | Demonstrates |
|---|---|---|
| [Simple Greeting](./examples/npm-libs/node/simple-greeting.ts) | Step Machine | Basic flow with file store |
| [AI Conversation](./examples/npm-libs/node/ai-conversation.ts) | Step Machine | Retry, circuit breakers, component injection |
| [Research Pipeline](./examples/npm-libs/event-graph/research-pipeline.ts) | Event Graph | Parallel tasks, goal-based completion |
| [CI/CD Pipeline](./examples/npm-libs/event-graph/ci-cd-pipeline.ts) | Event Graph | External events, conditional routing, failure tokens |
| [Batch Tickets](./examples/npm-libs/batch/batch-step-machine.ts) | Batch | Concurrent processing, progress tracking |
| [URL Pipeline](./examples/npm-libs/graph-of-graphs/url-processing-pipeline.ts) | Graph-of-Graphs | Outer event-graph → batch × inner event-graph per item |
| [Multi-Stage ETL](./examples/npm-libs/graph-of-graphs/multi-stage-etl.ts) | Graph-of-Graphs | Mixed modes: event-graph outer → step-machine + event-graph subs |
| [Stock Dashboard](./examples/npm-libs/continuous-event-graph/stock-dashboard.ts) | Continuous Event Graph | Runtime mutations, token drain, upstream/downstream, snapshot |
| [Reactive Pipeline](./examples/npm-libs/continuous-event-graph/reactive-pipeline.ts) | Reactive Graph | Self-driving ETL — push once, 4 tasks complete automatically |
| [Reactive Monitoring](./examples/npm-libs/continuous-event-graph/reactive-monitoring.ts) | Reactive Graph | Conditional routing, on_failure escalation, runtime addNode |
| [Live Portfolio Dashboard](./examples/npm-libs/continuous-event-graph/live-portfolio-dashboard.ts) | Reactive Graph + Live Cards | 15+ cards, disk roundtrip, addRequires/removeRequires, addProvides/removeProvides, pushAll, retriggerAll |
| [Executor Pipeline](./examples/npm-libs/event-graph/executor-pipeline.ts) | Event Graph (library) | You-drive-the-loop ETL with random async delays |
| [Executor Diamond](./examples/npm-libs/event-graph/executor-diamond.ts) | Event Graph (library) | Parallel fan-out/fan-in diamond DAG with async executors |
| [Azure Deployment](./examples/npm-libs/inference/azure-deployment.ts) | Inference | LLM analyzes deployment logs, auto-completes checkpoints |
| [Data Pipeline](./examples/npm-libs/inference/data-pipeline.ts) | Inference | Iterative inference — evidence arrives in waves |
| [Pluggable Adapters](./examples/npm-libs/inference/pluggable-adapters.ts) | Inference | OpenAI, Anthropic, Azure, CLI, HTTP adapter factories |
| [Copilot CLI](./examples/npm-libs/inference/copilot-cli.ts) | Inference | GitHub Copilot CLI as inference adapter via `createCliAdapter` |
| [Order Processing](./examples/npm-libs/flows/order-processing.yaml) | Step Machine | YAML flow definition |
| [Browser Demo](./examples/browser/step-machine-browser/index.html) | Step Machine | In-browser usage |

---

## Migrating from v1

v2 is backward compatible. The old names still work:

```typescript
// v1 (still works)
import { FlowEngine, createEngine } from 'yaml-flow';

// v2 (preferred)
import { StepMachine, createStepMachine } from 'yaml-flow/step-machine';
```

The `FlowStore` interface is now `StepMachineStore` (same shape). `RunState` is now `StepMachineState` (same shape). Both old names resolve to the new types.

## License

MIT
