/**
 * card-engine — Reactive DAG engine for LiveCards nodes.
 *
 * Builds a dependency graph from node declarations, resolves ExternalSource
 * fetches, propagates state changes, and provides a cross-node event bus.
 *
 * Isomorphic: works in browser (fetch) and Node.js (fetch / custom adapter).
 *
 * @example
 * ```typescript
 * import { CardEngine } from 'yaml-flow/card-engine';
 *
 * const engine = CardEngine.create({ nodes, fetcher: fetch });
 * await engine.start();          // fetch all sources, compute all cards
 * engine.on('state-change', ({ nodeId }) => console.log(nodeId, 'updated'));
 * engine.setState('card1', 'filters.region', 'US');   // triggers re-compute + dependents
 * ```
 */

import { CardCompute } from '../card-compute/index.js';
import type { ComputeNode } from '../card-compute/index.js';

// ============================================================================
// Types
// ============================================================================

/** Minimal fetch interface — subset of global fetch. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** A reactive node — Card or ExternalSource conforming to the LiveCards schema. */
export interface ReactiveNode extends ComputeNode {
  id: string;
  type: 'card' | 'source';
  meta?: { title?: string; tags?: string[]; [k: string]: unknown };
  data?: { requires?: string[]; provides?: Record<string, unknown> };
  view?: { elements?: unknown[]; layout?: Record<string, unknown>; features?: Record<string, unknown> };
  source?: {
    kind: 'api' | 'websocket' | 'static' | 'llm';
    bindTo: string;
    url_template?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    interval?: number;              // polling interval in ms
    transform?: string;             // optional jq-like path to extract from response
    [k: string]: unknown;
  };
  state: Record<string, unknown>;
}

/** Engine configuration. */
export interface EngineConfig {
  nodes: ReactiveNode[];
  fetcher?: Fetcher;
  /** Called when any node's state changes. */
  onChange?: (event: StateChangeEvent) => void;
}

/** Emitted on state changes. */
export interface StateChangeEvent {
  nodeId: string;
  path: string;
  value: unknown;
  previous: unknown;
}

/** Bus event. */
export interface BusEvent {
  type: string;
  source?: string;
  target?: string;
  payload?: unknown;
}

/** DAG edge: from → to (to depends on from). */
export interface Edge {
  from: string;
  to: string;
}

// ============================================================================
// Dependency DAG
// ============================================================================

function buildDAG(nodes: ReactiveNode[]): { order: string[]; edges: Edge[]; adj: Map<string, string[]> } {
  const nodeMap = new Map<string, ReactiveNode>();
  // Map node id → what it provides (from data.provides keys or, for sources, their id)
  const providerMap = new Map<string, string>();
  const edges: Edge[] = [];
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    nodeMap.set(n.id, n);
    adj.set(n.id, []);

    // Sources provide their own id as a dependency name
    if (n.type === 'source') {
      providerMap.set(n.id, n.id);
    }
    // Nodes with data.provides register each key
    if (n.data?.provides) {
      for (const key of Object.keys(n.data.provides)) {
        providerMap.set(key, n.id);
      }
    }
  }

  // Build edges from data.requires
  for (const n of nodes) {
    if (n.data?.requires) {
      for (const dep of n.data.requires) {
        const providerId = providerMap.get(dep);
        if (providerId && providerId !== n.id) {
          edges.push({ from: providerId, to: n.id });
          adj.get(providerId)!.push(n.id);
        }
      }
    }
  }

  // Topological sort (Kahn's algorithm)
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n.id, 0);
  for (const e of edges) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);

  const queue: string[] = [];
  for (const [id, deg] of inDeg) { if (deg === 0) queue.push(id); }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dep of (adj.get(id) || [])) {
      const newDeg = (inDeg.get(dep) || 1) - 1;
      inDeg.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  // If order doesn't include all nodes, there's a cycle — append remaining
  if (order.length < nodes.length) {
    for (const n of nodes) {
      if (!order.includes(n.id)) order.push(n.id);
    }
  }

  return { order, edges, adj };
}

// ============================================================================
// Deep path utilities (shared)
// ============================================================================

function deepGet(obj: unknown, path: string): unknown {
  if (!path || !obj) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

// ============================================================================
// URL template resolution
// ============================================================================

function resolveTemplate(template: string, state: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_m, key: string) => {
    const val = deepGet(state, key.trim());
    return val != null ? String(val) : '';
  });
}

// ============================================================================
// Source Adapter
// ============================================================================

async function fetchSource(
  node: ReactiveNode,
  fetcher: Fetcher,
  allState: Map<string, Record<string, unknown>>,
): Promise<void> {
  if (node.type !== 'source' || !node.source) return;
  const src = node.source;
  if (src.kind === 'static') {
    // Static sources don't fetch — data is inline in state already
    return;
  }

  if (src.kind === 'api' || src.kind === 'llm') {
    if (!src.url_template) return;

    // Build a combined state context for template resolution
    const ctx: Record<string, unknown> = { ...node.state };
    for (const [id, s] of allState) { ctx[id] = s; }

    const url = resolveTemplate(src.url_template, ctx);
    const method = (src.method || 'GET').toUpperCase();
    const headers = src.headers || {};

    const init: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'HEAD' && src.body) {
      init.body = typeof src.body === 'string' ? src.body : JSON.stringify(src.body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
    }

    try {
      node.state.status = 'loading';
      const resp = await fetcher(url, init);
      if (!resp.ok) {
        node.state.status = 'error';
        node.state._error = `HTTP ${resp.status}: ${resp.statusText}`;
        return;
      }
      let data = await resp.json();

      // Optional transform path
      if (src.transform) {
        data = deepGet(data, src.transform) ?? data;
      }

      // Write to bindTo path
      const bindPath = src.bindTo.startsWith('state.') ? src.bindTo.slice(6) : src.bindTo;
      deepSet(node.state, bindPath, data);
      node.state.status = 'fresh';
      node.state._error = undefined;
    } catch (err) {
      node.state.status = 'error';
      node.state._error = err instanceof Error ? err.message : String(err);
    }
  }

  // websocket handled elsewhere — not in initial fetch
}

// ============================================================================
// CardEngine — the reactive runtime
// ============================================================================

class CardEngineImpl {
  private _nodes: Map<string, ReactiveNode>;
  private _order: string[];
  private _edges: Edge[];
  private _adj: Map<string, string[]>;
  private _fetcher: Fetcher;
  private _listeners: Map<string, Array<(event: unknown) => void>>;
  private _timers: Map<string, ReturnType<typeof setInterval>>;
  private _started = false;

  constructor(config: EngineConfig) {
    this._nodes = new Map();
    for (const n of config.nodes) this._nodes.set(n.id, n);

    const dag = buildDAG(config.nodes);
    this._order = dag.order;
    this._edges = dag.edges;
    this._adj = dag.adj;

    this._fetcher = config.fetcher || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : (() => { throw new Error('No fetch available — provide config.fetcher'); }) as Fetcher);
    this._listeners = new Map();
    this._timers = new Map();

    if (config.onChange) {
      this.on('state-change', config.onChange as (e: unknown) => void);
    }
  }

  // ---------- Node accessors ----------

  get nodes(): ReactiveNode[] { return [...this._nodes.values()]; }
  get order(): string[] { return [...this._order]; }
  get edges(): Edge[] { return [...this._edges]; }

  getNode(id: string): ReactiveNode | undefined { return this._nodes.get(id); }

  // ---------- DAG info ----------

  /** Get immediate dependents of a node. */
  dependentsOf(id: string): string[] { return [...(this._adj.get(id) || [])]; }

  /** Get all nodes that this node depends on. */
  dependenciesOf(id: string): string[] {
    return this._edges.filter(e => e.to === id).map(e => e.from);
  }

  // ---------- Event bus ----------

  on(type: string, handler: (event: unknown) => void): () => void {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type)!.push(handler);
    // Return unsubscribe function
    return () => {
      const arr = this._listeners.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  emit(type: string, event: unknown): void {
    const handlers = this._listeners.get(type) || [];
    for (const h of handlers) {
      try { h(event); } catch (err) { console.error(`CardEngine: event handler error (${type}):`, err); }
    }
  }

  /** Broadcast a targeted event — sets state on target node and triggers cascade. */
  async dispatch(event: BusEvent): Promise<void> {
    this.emit(event.type, event);
    if (event.target && event.payload !== undefined) {
      const target = this._nodes.get(event.target);
      if (target) {
        await this.setState(event.target, 'event.' + event.type, event.payload);
      }
    }
  }

  // ---------- State management ----------

  /** Set a state value on a node and propagate changes through the DAG. */
  async setState(nodeId: string, path: string, value: unknown): Promise<void> {
    const node = this._nodes.get(nodeId);
    if (!node) return;

    const fullPath = path.startsWith('state.') ? path.slice(6) : path;
    const previous = deepGet(node.state, fullPath);
    deepSet(node.state, fullPath, value);

    // Emit change event
    this.emit('state-change', { nodeId, path: fullPath, value, previous } as StateChangeEvent);

    // Re-compute this node
    if (node.compute) CardCompute.run(node);

    // Cascade to dependents (in topological order)
    await this._cascade(nodeId);
  }

  /** Get a state value from a node. */
  getState(nodeId: string, path?: string): unknown {
    const node = this._nodes.get(nodeId);
    if (!node) return undefined;
    if (!path) return node.state;
    const fp = path.startsWith('state.') ? path.slice(6) : path;
    return deepGet(node.state, fp);
  }

  // ---------- Lifecycle ----------

  /** Start the engine: fetch all sources (in topological order), compute all cards. */
  async start(): Promise<void> {
    this._started = true;
    const allState = new Map<string, Record<string, unknown>>();
    for (const [id, n] of this._nodes) allState.set(id, n.state);

    // Process nodes in topological order
    for (const id of this._order) {
      const node = this._nodes.get(id)!;

      // Fetch sources
      if (node.type === 'source') {
        await fetchSource(node, this._fetcher, allState);
        allState.set(id, node.state);
      }

      // Run compute on all nodes
      if (node.compute) CardCompute.run(node);
    }

    // Start polling for sources with interval
    for (const node of this._nodes.values()) {
      if (node.type === 'source' && node.source?.interval && node.source.interval > 0) {
        this._startPolling(node);
      }
    }

    this.emit('started', { order: this._order });
  }

  /** Stop the engine — clear all polling timers. */
  stop(): void {
    this._started = false;
    for (const [, timer] of this._timers) {
      clearInterval(timer);
    }
    this._timers.clear();
    this.emit('stopped', {});
  }

  /** Take a JSON snapshot of all node states. */
  snapshot(): Record<string, Record<string, unknown>> {
    const snap: Record<string, Record<string, unknown>> = {};
    for (const [id, node] of this._nodes) {
      snap[id] = JSON.parse(JSON.stringify(node.state));
    }
    return snap;
  }

  /** Restore from a snapshot. */
  restore(snap: Record<string, Record<string, unknown>>): void {
    for (const [id, state] of Object.entries(snap)) {
      const node = this._nodes.get(id);
      if (node) node.state = JSON.parse(JSON.stringify(state));
    }
  }

  /** Add a node dynamically. Rebuilds the DAG. */
  addNode(node: ReactiveNode): void {
    this._nodes.set(node.id, node);
    this._rebuildDAG();
  }

  /** Remove a node dynamically. Rebuilds the DAG. */
  removeNode(id: string): void {
    this._nodes.delete(id);
    this._timers.get(id) && clearInterval(this._timers.get(id)!);
    this._timers.delete(id);
    this._rebuildDAG();
  }

  // ---------- Internal ----------

  private _rebuildDAG(): void {
    const dag = buildDAG([...this._nodes.values()]);
    this._order = dag.order;
    this._edges = dag.edges;
    this._adj = dag.adj;
  }

  /** Cascade recompute/refetch to all dependents of nodeId in topological order. */
  private async _cascade(nodeId: string): Promise<void> {
    // Collect all transitive dependents in topological order
    const visited = new Set<string>();
    const toProcess: string[] = [];
    const collect = (id: string) => {
      for (const dep of (this._adj.get(id) || [])) {
        if (!visited.has(dep)) {
          visited.add(dep);
          toProcess.push(dep);
          collect(dep);
        }
      }
    };
    collect(nodeId);

    // Sort by topological order
    const orderIndex = new Map(this._order.map((id, i) => [id, i]));
    toProcess.sort((a, b) => (orderIndex.get(a) || 0) - (orderIndex.get(b) || 0));

    const allState = new Map<string, Record<string, unknown>>();
    for (const [id, n] of this._nodes) allState.set(id, n.state);

    for (const depId of toProcess) {
      const dep = this._nodes.get(depId)!;
      if (dep.type === 'source') {
        await fetchSource(dep, this._fetcher, allState);
        allState.set(depId, dep.state);
      }
      if (dep.compute) CardCompute.run(dep);
      this.emit('state-change', { nodeId: depId, path: '*', value: dep.state, previous: undefined });
    }
  }

  private _startPolling(node: ReactiveNode): void {
    if (!node.source?.interval) return;
    const timer = setInterval(async () => {
      if (!this._started) return;
      const allState = new Map<string, Record<string, unknown>>();
      for (const [id, n] of this._nodes) allState.set(id, n.state);
      await fetchSource(node, this._fetcher, allState);
      if (node.compute) CardCompute.run(node);
      await this._cascade(node.id);
    }, node.source.interval);
    this._timers.set(node.id, timer);
  }
}

// ============================================================================
// Public API
// ============================================================================

export const CardEngine = {
  /** Create a new reactive engine. */
  create(config: EngineConfig): CardEngineImpl {
    return new CardEngineImpl(config);
  },

  /** Build the dependency DAG without creating a full engine. */
  buildDAG(nodes: ReactiveNode[]): { order: string[]; edges: Edge[] } {
    const { order, edges } = buildDAG(nodes);
    return { order, edges };
  },

  /** Fetch a single source node (standalone utility). */
  async fetchSource(node: ReactiveNode, fetcher?: Fetcher): Promise<void> {
    const f = fetcher || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (!f) throw new Error('No fetch available — provide a fetcher');
    await fetchSource(node, f, new Map([[node.id, node.state]]));
  },
};

export type { CardEngineImpl as CardEngineInstance };
export default CardEngine;
