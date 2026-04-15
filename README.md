# yaml-flow

A lightweight, isomorphic workflow engine with declarative YAML flows and pluggable persistence.

[![npm version](https://badge.fury.io/js/yaml-flow.svg)](https://www.npmjs.com/package/yaml-flow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Isomorphic** — Runs in both browser and Node.js
- **Declarative Flows** — Define workflows in YAML with JSON Schema validation
- **Pure Function Handlers** — Step handlers are simple `(input, context) => result` functions
- **Pluggable Storage** — Bring your own persistence (memory, localStorage, file, Redis, etc.)
- **Zero Core Dependencies** — Lightweight core, optional add-ons for YAML parsing
- **Resumable** — Pause and resume flows from persisted state
- **Circuit Breakers** — Prevent infinite loops with configurable limits
- **Retry Logic** — Built-in exponential backoff for failed steps
- **Event System** — Subscribe to flow events for UI updates

## Installation

```bash
npm install yaml-flow
```

## Quick Start

### 1. Define Your Flow (YAML)

```yaml
# my-flow.yaml
settings:
  start_step: greet
  max_total_steps: 10

steps:
  greet:
    produces_data:
      - message
    transitions:
      success: done
      failure: error

terminal_states:
  done:
    return_intent: success
    return_artifacts: message
  
  error:
    return_intent: error
    return_artifacts: false
```

### 2. Create Step Handlers

```typescript
import { createEngine, loadFlow, MemoryStore } from 'yaml-flow';

const handlers = {
  greet: async (input, ctx) => {
    return {
      result: 'success',
      data: { message: `Hello, ${input.name}!` }
    };
  }
};
```

### 3. Run the Flow

```typescript
const flow = await loadFlow('./my-flow.yaml');
const engine = createEngine(flow, handlers);

const result = await engine.run({ name: 'World' });
console.log(result.data.message); // "Hello, World!"
```

## Flow Configuration

### Settings

```yaml
settings:
  start_step: my_step      # Required: First step to execute
  max_total_steps: 100     # Optional: Circuit breaker (default: 100)
  timeout_ms: 60000        # Optional: Flow timeout in ms
```

### Steps

```yaml
steps:
  my_step:
    description: "What this step does"
    expects_data:          # Input data keys
      - input_key
    produces_data:         # Output data keys
      - output_key
    transitions:           # Result -> next step mapping
      success: next_step
      failure: error_step
    retry:                 # Optional retry config
      max_attempts: 3
      delay_ms: 1000
      backoff_multiplier: 2
    circuit_breaker:       # Optional loop protection
      max_iterations: 5
      on_open: fallback_step
```

### Terminal States

```yaml
terminal_states:
  success:
    return_intent: "success"
    return_artifacts:
      - result_data
      - metadata
  
  error:
    return_intent: "error"
    return_artifacts: false
```

## Step Handlers

Step handlers are pure async functions:

```typescript
type StepHandler = (input: StepInput, context: StepContext) => Promise<StepResult>;

interface StepInput {
  [key: string]: unknown;  // Data from expects_data
}

interface StepContext {
  runId: string;           // Current run ID
  stepName: string;        // Current step name
  components: object;      // Injected dependencies
  store: FlowStore;        // Direct store access
  signal?: AbortSignal;    // Cancellation signal
  emit: (event, data) => void;  // Event emitter
}

interface StepResult {
  result: string;          // Transition key (e.g., 'success', 'failure')
  data?: object;           // Output data (matches produces_data)
}
```

### Example Handler

```typescript
const handlers = {
  async processOrder(input, ctx) {
    const { order } = input;
    
    // Access injected database client
    const db = ctx.components.db;
    
    try {
      const savedOrder = await db.orders.save(order);
      
      return {
        result: 'success',
        data: { 
          order_id: savedOrder.id,
          status: 'pending'
        }
      };
    } catch (error) {
      return {
        result: 'failure',
        data: { error: error.message }
      };
    }
  }
};
```

## Storage Adapters

### Memory (Default)

```typescript
import { MemoryStore } from 'yaml-flow';

const engine = createEngine(flow, handlers, {
  store: new MemoryStore()
});
```

### LocalStorage (Browser)

```typescript
import { LocalStorageStore } from 'yaml-flow/stores/localStorage';

const engine = createEngine(flow, handlers, {
  store: new LocalStorageStore({ prefix: 'myapp' })
});
```

### File System (Node.js)

```typescript
import { FileStore } from 'yaml-flow/stores/file';

const engine = createEngine(flow, handlers, {
  store: new FileStore({ directory: './flow-data' })
});
```

### Custom Store

Implement the `FlowStore` interface:

```typescript
interface FlowStore {
  saveRunState(runId: string, state: RunState): Promise<void>;
  loadRunState(runId: string): Promise<RunState | null>;
  deleteRunState(runId: string): Promise<void>;
  setData(runId: string, key: string, value: unknown): Promise<void>;
  getData(runId: string, key: string): Promise<unknown>;
  getAllData(runId: string): Promise<Record<string, unknown>>;
  clearData(runId: string): Promise<void>;
}
```

## Component Injection

Inject external dependencies (databases, API clients, etc.):

```typescript
const engine = createEngine(flow, handlers, {
  components: {
    db: databaseClient,
    api: httpClient,
    cache: redisClient,
    ai: openAIClient
  }
});

// Access in handlers
const handlers = {
  async fetchData(input, ctx) {
    const result = await ctx.components.api.get('/data');
    return { result: 'success', data: { fetched: result } };
  }
};
```

## Events

Subscribe to flow events:

```typescript
const engine = createEngine(flow, handlers);

// Subscribe to events
const unsubscribe = engine.on('step:complete', (event) => {
  console.log(`Step ${event.data.step} completed with ${event.data.result}`);
});

// Available events:
// - flow:start, flow:complete, flow:error, flow:paused, flow:resumed
// - step:start, step:complete, step:error
// - transition
```

## Pause & Resume

```typescript
// Start flow
const result = engine.run({ data: 'value' });

// Pause (from another context)
await engine.pause(runId);

// Later: resume
const resumed = await engine.resume(runId);
```

## Cancellation

```typescript
const controller = new AbortController();

const engine = createEngine(flow, handlers, {
  signal: controller.signal
});

// Start flow
const resultPromise = engine.run();

// Cancel
controller.abort();
```

## Browser Usage

### With Bundler (Vite, webpack, etc.)

```typescript
import { createEngine, MemoryStore } from 'yaml-flow';

// Flow as JSON (pre-parsed at build time)
const flow = {
  settings: { start_step: 'start' },
  steps: { start: { transitions: { success: 'done' } } },
  terminal_states: { done: { return_intent: 'success' } }
};

const engine = createEngine(flow, handlers);
```

### From URL

```typescript
import { loadFlowFromUrl, createEngine } from 'yaml-flow';

const flow = await loadFlowFromUrl('/flows/my-flow.json');
const engine = createEngine(flow, handlers);
```

## JSON Schema

Use the included JSON Schema for IDE autocomplete:

```yaml
# yaml-language-server: $schema=node_modules/yaml-flow/schema/flow.schema.json

settings:
  start_step: my_step
  # ... IDE autocomplete works here
```

## API Reference

### `createEngine(flow, handlers, options?)`

Create a new flow engine instance.

### `loadFlow(source)`

Load and validate a flow from file path, URL, or object.

### `FlowEngine.run(initialData?)`

Execute the flow from start.

### `FlowEngine.resume(runId)`

Resume a paused flow.

### `FlowEngine.pause(runId)`

Pause a running flow.

### `FlowEngine.on(event, listener)`

Subscribe to flow events.

### `FlowEngine.getStore()`

Get the store instance.

## Examples

See the [examples](./examples) directory:

- [Simple Greeting (Node.js)](./examples/node/simple-greeting.ts)
- [AI Conversation (Node.js)](./examples/node/ai-conversation.ts)
- [Browser Demo](./examples/browser/index.html)
- [Order Processing (Flow)](./examples/flows/order-processing.yaml)

## License

MIT
