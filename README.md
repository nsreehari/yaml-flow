# yaml-flow

Two workflow engines in one package. Pick the model that fits your problem.

[![npm version](https://badge.fury.io/js/yaml-flow.svg)](https://www.npmjs.com/package/yaml-flow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

```
npm install yaml-flow
```

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
    provides: [raw-sources]

  analyse_sentiment:
    requires: [raw-sources]
    provides: [sentiment-result]

  analyse_entities:
    requires: [raw-sources]
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
| Repeatable tasks | `repeatable: true` or `repeatable: { max: 5 }` | Task can re-execute when its inputs refresh |
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

An agent needs to gather evidence from multiple sources, then synthesize.

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
    repeatable: { max: 3 }
```

The three searches run in parallel. `synthesize` waits for all three. `verify` can produce different token sets depending on its result. If rejected, `revise` picks up and feeds back into `verify` (up to 3 times). If verify itself fails, `verification-skipped` unblocks any downstream task waiting on it.

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

## Package Exports

```typescript
// Everything (both modes + stores)
import { StepMachine, next, apply, MemoryStore } from 'yaml-flow';

// Step Machine only
import { StepMachine, createStepMachine, loadStepFlow } from 'yaml-flow/step-machine';
import { applyStepResult, checkCircuitBreaker, createInitialState } from 'yaml-flow/step-machine';

// Event Graph only
import { next, apply, applyAll, getCandidateTasks } from 'yaml-flow/event-graph';
import { createInitialExecutionState, isExecutionComplete, detectStuckState } from 'yaml-flow/event-graph';
import { TASK_STATUS, COMPLETION_STRATEGIES, CONFLICT_STRATEGIES } from 'yaml-flow/event-graph';

// Stores
import { MemoryStore, LocalStorageStore, FileStore } from 'yaml-flow/stores';

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
| [Simple Greeting](./examples/node/simple-greeting.ts) | Step Machine | Basic flow with file store |
| [AI Conversation](./examples/node/ai-conversation.ts) | Step Machine | Retry, circuit breakers, component injection |
| [Research Pipeline](./examples/event-graph/research-pipeline.ts) | Event Graph | Parallel tasks, goal-based completion |
| [CI/CD Pipeline](./examples/event-graph/ci-cd-pipeline.ts) | Event Graph | External events, conditional routing, failure tokens |
| [Order Processing](./examples/flows/order-processing.yaml) | Step Machine | YAML flow definition |
| [Browser Demo](./examples/browser/index.html) | Step Machine | In-browser usage |

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
