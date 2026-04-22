var BoardLiveGraph = (function (exports) {
  'use strict';

  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, key + "" , value);

  // jsonata-global-shim:jsonata-shim
  var _jsonata = typeof globalThis !== "undefined" && globalThis.jsonata || typeof window !== "undefined" && window.jsonata;
  var jsonata_shim_default = _jsonata;

  // src/card-compute/index.ts
  function deepGet(obj, path) {
    if (!path || !obj) return void 0;
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur == null) return void 0;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function deepSet(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  async function run(node, options) {
    if (!node?.compute?.length) return node;
    if (!node.card_data) node.card_data = {};
    node.computed_values = {};
    node._sourcesData = options?.sourcesData ?? {};
    const ctx = {
      card_data: node.card_data,
      requires: node.requires ?? {},
      sources: node._sourcesData,
      computed_values: node.computed_values
    };
    for (const step of node.compute) {
      try {
        const val = await jsonata_shim_default(step.expr).evaluate(ctx);
        deepSet(node.computed_values, step.bindTo, val);
        ctx.computed_values = node.computed_values;
      } catch (err) {
        console.error(`CardCompute.run error on "${node.id ?? "?"}.${step.bindTo}":`, err);
      }
    }
    return node;
  }
  async function evalExpr(expr, node) {
    const ctx = {
      card_data: node.card_data ?? {},
      requires: node.requires ?? {},
      sources: node._sourcesData ?? {},
      computed_values: node.computed_values ?? {}
    };
    return jsonata_shim_default(expr).evaluate(ctx);
  }
  function resolve(node, path) {
    if (path.startsWith("sources.")) {
      return deepGet(node._sourcesData ?? {}, path.slice("sources.".length));
    }
    return deepGet(node, path);
  }
  var VALID_ELEMENT_KINDS = /* @__PURE__ */ new Set([
    "metric",
    "table",
    "chart",
    "form",
    "filter",
    "list",
    "notes",
    "todo",
    "alert",
    "narrative",
    "badge",
    "text",
    "markdown",
    "custom"
  ]);
  var ALLOWED_KEYS = /* @__PURE__ */ new Set(["id", "meta", "requires", "provides", "view", "card_data", "compute", "sources"]);
  function validateNode(node) {
    const errors = [];
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return { ok: false, errors: ["Node must be a non-null object"] };
    }
    const n = node;
    if (typeof n.id !== "string" || !n.id) errors.push("id: required, must be a non-empty string");
    for (const key of Object.keys(n)) {
      if (!ALLOWED_KEYS.has(key)) errors.push(`Unknown top-level key: "${key}"`);
    }
    if (n.card_data == null || typeof n.card_data !== "object" || Array.isArray(n.card_data)) {
      errors.push("card_data: required, must be an object");
    }
    if (n.meta != null) {
      if (typeof n.meta !== "object" || Array.isArray(n.meta)) {
        errors.push("meta: must be an object");
      } else {
        const meta = n.meta;
        if (meta.title != null && typeof meta.title !== "string") errors.push("meta.title: must be a string");
        if (meta.tags != null && !Array.isArray(meta.tags)) errors.push("meta.tags: must be an array");
      }
    }
    if (n.requires != null && !Array.isArray(n.requires)) errors.push("requires: must be an array of strings");
    if (n.provides != null) {
      if (!Array.isArray(n.provides)) {
        errors.push("provides: must be an array of { bindTo, src } bindings");
      } else {
        n.provides.forEach((p, i) => {
          if (!p || typeof p !== "object" || Array.isArray(p)) {
            errors.push(`provides[${i}]: must be an object with bindTo and src`);
          } else {
            const b = p;
            if (typeof b.bindTo !== "string" || !b.bindTo) errors.push(`provides[${i}]: missing required "bindTo" string`);
            if (typeof b.src !== "string" || !b.src) errors.push(`provides[${i}]: missing required "src" string`);
          }
        });
      }
    }
    if (n.compute != null) {
      if (!Array.isArray(n.compute)) {
        errors.push("compute: must be an array of compute steps");
      } else {
        n.compute.forEach((step, i) => {
          if (!step || typeof step !== "object" || Array.isArray(step)) {
            errors.push(`compute[${i}]: must be a compute step object`);
          } else {
            const s = step;
            if (typeof s.bindTo !== "string" || !s.bindTo) errors.push(`compute[${i}]: missing required "bindTo" property`);
            if (typeof s.expr !== "string" || !s.expr) errors.push(`compute[${i}]: missing required "expr" string (JSONata expression)`);
          }
        });
      }
    }
    if (n.sources != null) {
      if (!Array.isArray(n.sources)) {
        errors.push("sources: must be an array");
      } else {
        n.sources.forEach((src, i) => {
          if (!src || typeof src !== "object" || Array.isArray(src)) {
            errors.push(`sources[${i}]: must be an object`);
          } else {
            const s = src;
            if (typeof s.bindTo !== "string" || !s.bindTo) errors.push(`sources[${i}]: missing required "bindTo" property`);
            if (s.outputFile != null && typeof s.outputFile !== "string") errors.push(`sources[${i}]: outputFile must be a string`);
            if (s.optionalForCompletionGating != null && typeof s.optionalForCompletionGating !== "boolean") {
              errors.push(`sources[${i}]: optionalForCompletionGating must be a boolean`);
            }
          }
        });
      }
    }
    if (n.view != null) {
      if (typeof n.view !== "object" || Array.isArray(n.view)) {
        errors.push("view: must be an object");
      } else {
        const view = n.view;
        if (!Array.isArray(view.elements) || view.elements.length === 0) {
          errors.push("view.elements: required, must be a non-empty array");
        } else {
          view.elements.forEach((elem, i) => {
            if (!elem || typeof elem !== "object") {
              errors.push(`view.elements[${i}]: must be an object`);
              return;
            }
            if (!elem.kind || typeof elem.kind !== "string") {
              errors.push(`view.elements[${i}].kind: required, must be a string`);
            } else if (!VALID_ELEMENT_KINDS.has(elem.kind)) {
              errors.push(`view.elements[${i}].kind: unknown kind "${elem.kind}". Valid: ${[...VALID_ELEMENT_KINDS].join(", ")}`);
            }
            if (elem.data != null && (typeof elem.data !== "object" || Array.isArray(elem.data))) {
              errors.push(`view.elements[${i}].data: must be an object`);
            }
          });
        }
        if (view.layout != null && (typeof view.layout !== "object" || Array.isArray(view.layout))) errors.push("view.layout: must be an object");
        if (view.features != null && (typeof view.features !== "object" || Array.isArray(view.features))) errors.push("view.features: must be an object");
      }
    }
    return { ok: errors.length === 0, errors };
  }
  var CardCompute = {
    run,
    eval: evalExpr,
    resolve,
    validate: validateNode
  };

  // src/event-graph/constants.ts
  var TASK_STATUS = {
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    INACTIVATED: "inactivated"
  };

  // src/event-graph/graph-helpers.ts
  function getProvides(task) {
    if (!task) return [];
    if (Array.isArray(task.provides)) return task.provides;
    return [];
  }
  function getRequires(task) {
    if (!task) return [];
    if (Array.isArray(task.requires)) return task.requires;
    return [];
  }
  function getAllTasks(graph) {
    return graph.tasks ?? {};
  }
  function isNonActiveTask(taskState) {
    if (!taskState) return false;
    return taskState.status === TASK_STATUS.FAILED || taskState.status === TASK_STATUS.INACTIVATED;
  }
  function getRefreshStrategy(taskConfig, graphSettings) {
    return taskConfig.refreshStrategy ?? graphSettings?.refreshStrategy ?? "data-changed";
  }
  function getMaxExecutions(taskConfig) {
    return taskConfig.maxExecutions;
  }
  function computeAvailableOutputs(graph, taskStates) {
    const outputs = /* @__PURE__ */ new Set();
    for (const [taskName, taskState] of Object.entries(taskStates)) {
      if (taskState.status === TASK_STATUS.COMPLETED) {
        const taskConfig = graph.tasks[taskName];
        if (taskConfig) {
          const provides = getProvides(taskConfig);
          provides.forEach((output) => outputs.add(output));
        }
      }
    }
    return Array.from(outputs);
  }
  function groupTasksByProvides(candidateTaskNames, tasks) {
    const outputGroups = {};
    candidateTaskNames.forEach((taskName) => {
      const task = tasks[taskName];
      if (!task) return;
      const provides = getProvides(task);
      provides.forEach((output) => {
        if (!outputGroups[output]) {
          outputGroups[output] = [];
        }
        outputGroups[output].push(taskName);
      });
    });
    return outputGroups;
  }

  // src/event-graph/task-transitions.ts
  function applyTaskStart(state, taskName) {
    const existingTask = state.tasks[taskName] ?? createDefaultGraphEngineStore();
    const updatedTask = {
      ...existingTask,
      status: "running",
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
      progress: 0,
      error: void 0
    };
    return {
      ...state,
      tasks: { ...state.tasks, [taskName]: updatedTask },
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  function applyTaskCompletion(state, graph, taskName, result, dataHash, data) {
    const existingTask = state.tasks[taskName] ?? createDefaultGraphEngineStore();
    const taskConfig = graph.tasks[taskName];
    if (!taskConfig) {
      throw new Error(`Task "${taskName}" not found in graph`);
    }
    let outputTokens;
    if (result && taskConfig.on && taskConfig.on[result]) {
      outputTokens = taskConfig.on[result];
    } else {
      outputTokens = getProvides(taskConfig);
    }
    const lastConsumedHashes = { ...existingTask.lastConsumedHashes };
    const requires = taskConfig.requires ?? [];
    for (const token of requires) {
      for (const [otherName, otherConfig] of Object.entries(graph.tasks)) {
        if (getProvides(otherConfig).includes(token)) {
          const otherState = state.tasks[otherName];
          if (otherState?.lastDataHash) {
            lastConsumedHashes[token] = otherState.lastDataHash;
          }
          break;
        }
      }
    }
    const updatedTask = {
      ...existingTask,
      status: "completed",
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
      executionCount: existingTask.executionCount + 1,
      lastEpoch: existingTask.executionCount + 1,
      lastDataHash: dataHash,
      data,
      lastConsumedHashes,
      error: void 0
    };
    const newOutputs = [.../* @__PURE__ */ new Set([...state.availableOutputs, ...outputTokens])];
    return {
      ...state,
      tasks: { ...state.tasks, [taskName]: updatedTask },
      availableOutputs: newOutputs,
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  function applyTaskFailure(state, graph, taskName, error) {
    const existingTask = state.tasks[taskName] ?? createDefaultGraphEngineStore();
    const taskConfig = graph.tasks[taskName];
    if (taskConfig?.retry) {
      const retryCount = existingTask.retryCount + 1;
      if (retryCount <= taskConfig.retry.max_attempts) {
        const updatedTask2 = {
          ...existingTask,
          status: "not-started",
          retryCount,
          lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
          error
        };
        return {
          ...state,
          tasks: { ...state.tasks, [taskName]: updatedTask2 },
          lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
        };
      }
    }
    const updatedTask = {
      ...existingTask,
      status: "failed",
      failedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
      error,
      executionCount: existingTask.executionCount + 1
    };
    let newOutputs = state.availableOutputs;
    if (taskConfig?.on_failure && taskConfig.on_failure.length > 0) {
      newOutputs = [.../* @__PURE__ */ new Set([...state.availableOutputs, ...taskConfig.on_failure])];
    }
    if (taskConfig?.circuit_breaker && updatedTask.executionCount >= taskConfig.circuit_breaker.max_executions) {
      const breakTokens = taskConfig.circuit_breaker.on_break;
      newOutputs = [.../* @__PURE__ */ new Set([...newOutputs, ...breakTokens])];
    }
    return {
      ...state,
      tasks: { ...state.tasks, [taskName]: updatedTask },
      availableOutputs: newOutputs,
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  function applyTaskProgress(state, taskName, message, progress) {
    const existingTask = state.tasks[taskName] ?? createDefaultGraphEngineStore();
    const updatedTask = {
      ...existingTask,
      progress: typeof progress === "number" ? progress : existingTask.progress,
      messages: [
        ...existingTask.messages ?? [],
        ...message ? [{ message, timestamp: (/* @__PURE__ */ new Date()).toISOString(), status: existingTask.status }] : []
      ],
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
    return {
      ...state,
      tasks: { ...state.tasks, [taskName]: updatedTask },
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  function applyTaskRestart(state, taskName) {
    const existingTask = state.tasks[taskName];
    if (!existingTask) return state;
    const updatedTask = {
      ...existingTask,
      status: "not-started",
      startedAt: void 0,
      completedAt: void 0,
      failedAt: void 0,
      error: void 0,
      data: void 0,
      progress: null,
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
    return {
      ...state,
      tasks: { ...state.tasks, [taskName]: updatedTask },
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  function createDefaultGraphEngineStore() {
    return {
      status: "not-started",
      executionCount: 0,
      retryCount: 0,
      lastEpoch: 0,
      messages: [],
      progress: null
    };
  }

  // src/continuous-event-graph/core.ts
  function createLiveGraph(config, executionId) {
    const id = executionId ?? `live-${Date.now()}`;
    const tasks = {};
    for (const taskName of Object.keys(config.tasks)) {
      tasks[taskName] = createDefaultGraphEngineStore2();
    }
    const state = {
      status: "running",
      tasks,
      availableOutputs: [],
      stuckDetection: { is_stuck: false, stuck_description: null, outputs_unresolvable: [], tasks_blocked: [] },
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
      executionId: id,
      executionConfig: {
        executionMode: config.settings.execution_mode ?? "eligibility-mode",
        conflictStrategy: config.settings.conflict_strategy ?? "alphabetical",
        completionStrategy: config.settings.completion
      }
    };
    return { config, state };
  }
  function applyEvent(live, event) {
    const { config, state } = live;
    if ("executionId" in event && event.executionId && event.executionId !== state.executionId) {
      return live;
    }
    switch (event.type) {
      // --- Execution state transitions ---
      case "task-started":
        return { config, state: applyTaskStart(state, event.taskName) };
      case "task-completed":
        return { config, state: applyTaskCompletion(state, config, event.taskName, event.result, event.dataHash, event.data) };
      case "task-failed":
        return { config, state: applyTaskFailure(state, config, event.taskName, event.error) };
      case "task-progress":
        return { config, state: applyTaskProgress(state, event.taskName, event.message, event.progress) };
      case "task-restart":
        return { config, state: applyTaskRestart(state, event.taskName) };
      case "inject-tokens":
        return {
          config,
          state: {
            ...state,
            availableOutputs: [.../* @__PURE__ */ new Set([...state.availableOutputs, ...event.tokens])],
            lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
          }
        };
      case "agent-action":
        return { config, state: applyAgentAction(state, event.action) };
      // --- Structural mutations ---
      case "task-upsert":
        return addNode(live, event.taskName, event.taskConfig);
      case "task-removal":
        return removeNode(live, event.taskName);
      case "node-requires-add":
        return addRequires(live, event.nodeName, event.tokens);
      case "node-requires-remove":
        return removeRequires(live, event.nodeName, event.tokens);
      case "node-provides-add":
        return addProvides(live, event.nodeName, event.tokens);
      case "node-provides-remove":
        return removeProvides(live, event.nodeName, event.tokens);
      default:
        return live;
    }
  }
  function applyEvents(live, events) {
    return events.reduce((current, event) => applyEvent(current, event), live);
  }
  function addNode(live, name, taskConfig) {
    const exists = !!live.config.tasks[name];
    return {
      config: {
        ...live.config,
        tasks: { ...live.config.tasks, [name]: taskConfig }
      },
      state: {
        ...live.state,
        tasks: {
          ...live.state.tasks,
          [name]: exists ? live.state.tasks[name] : createDefaultGraphEngineStore2()
        },
        lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
  }
  function removeNode(live, name) {
    if (!live.config.tasks[name]) return live;
    const { [name]: _removedConfig, ...remainingTasks } = live.config.tasks;
    const { [name]: _removedState, ...remainingStates } = live.state.tasks;
    return {
      config: {
        ...live.config,
        tasks: remainingTasks
      },
      state: {
        ...live.state,
        tasks: remainingStates,
        lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
  }
  function addRequires(live, nodeName, tokens) {
    const task = live.config.tasks[nodeName];
    if (!task) return live;
    const current = getRequires(task);
    const toAdd = tokens.filter((t) => !current.includes(t));
    if (toAdd.length === 0) return live;
    return {
      config: {
        ...live.config,
        tasks: {
          ...live.config.tasks,
          [nodeName]: { ...task, requires: [...current, ...toAdd] }
        }
      },
      state: live.state
    };
  }
  function removeRequires(live, nodeName, tokens) {
    const task = live.config.tasks[nodeName];
    if (!task) return live;
    const current = getRequires(task);
    const remaining = current.filter((t) => !tokens.includes(t));
    if (remaining.length === current.length) return live;
    return {
      config: {
        ...live.config,
        tasks: {
          ...live.config.tasks,
          [nodeName]: { ...task, requires: remaining }
        }
      },
      state: live.state
    };
  }
  function addProvides(live, nodeName, tokens) {
    const task = live.config.tasks[nodeName];
    if (!task) return live;
    const current = getProvides(task);
    const toAdd = tokens.filter((t) => !current.includes(t));
    if (toAdd.length === 0) return live;
    return {
      config: {
        ...live.config,
        tasks: {
          ...live.config.tasks,
          [nodeName]: { ...task, provides: [...current, ...toAdd] }
        }
      },
      state: live.state
    };
  }
  function removeProvides(live, nodeName, tokens) {
    const task = live.config.tasks[nodeName];
    if (!task) return live;
    const current = getProvides(task);
    const remaining = current.filter((t) => !tokens.includes(t));
    if (remaining.length === current.length) return live;
    return {
      config: {
        ...live.config,
        tasks: {
          ...live.config.tasks,
          [nodeName]: { ...task, provides: remaining }
        }
      },
      state: live.state
    };
  }
  function snapshot(live) {
    return {
      version: 1,
      config: live.config,
      state: live.state,
      snapshotAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  function createDefaultGraphEngineStore2() {
    return {
      status: "not-started",
      executionCount: 0,
      retryCount: 0,
      lastEpoch: 0,
      messages: [],
      progress: null
    };
  }
  function applyAgentAction(state, action) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    switch (action) {
      case "stop":
        return { ...state, status: "stopped", lastUpdated: now };
      case "pause":
        return { ...state, status: "paused", lastUpdated: now };
      case "resume":
        return { ...state, status: "running", lastUpdated: now };
      default:
        return state;
    }
  }

  // src/continuous-event-graph/schedule.ts
  function schedule(live) {
    const { config, state } = live;
    const graphTasks = getAllTasks(config);
    const taskNames = Object.keys(graphTasks);
    if (taskNames.length === 0) {
      return { eligible: [], pending: [], unresolved: [], blocked: [], conflicts: {} };
    }
    const producerMap = buildProducerMap(graphTasks);
    const computedOutputs = computeAvailableOutputs(config, state.tasks);
    const availableOutputs = /* @__PURE__ */ new Set([...computedOutputs, ...state.availableOutputs]);
    const eligible = [];
    const pending = [];
    const unresolved = [];
    const blocked = [];
    for (const [taskName, taskConfig] of Object.entries(graphTasks)) {
      const taskState = state.tasks[taskName];
      const strategy = getRefreshStrategy(taskConfig, config.settings);
      const rerunnable = strategy !== "once";
      if (taskState?.status === TASK_STATUS.RUNNING || isNonActiveTask(taskState)) {
        continue;
      }
      const maxExec = getMaxExecutions(taskConfig);
      if (maxExec !== void 0 && taskState && taskState.executionCount >= maxExec) {
        continue;
      }
      if (taskConfig.circuit_breaker && taskState && taskState.executionCount >= taskConfig.circuit_breaker.max_executions) {
        continue;
      }
      if (!rerunnable && taskState?.status === TASK_STATUS.COMPLETED) {
        continue;
      }
      if (rerunnable && taskState?.status === TASK_STATUS.COMPLETED) {
        const requires2 = getRequires(taskConfig);
        let shouldSkip = false;
        switch (strategy) {
          case "data-changed": {
            if (requires2.length > 0) {
              const hasChangedData = requires2.some((req) => {
                for (const [otherName, otherConfig] of Object.entries(graphTasks)) {
                  if (getProvides(otherConfig).includes(req)) {
                    const otherState = state.tasks[otherName];
                    if (!otherState) continue;
                    const consumed = taskState.lastConsumedHashes?.[req];
                    if (otherState.lastDataHash == null) {
                      return otherState.executionCount > taskState.lastEpoch;
                    }
                    return otherState.lastDataHash !== consumed;
                  }
                }
                return false;
              });
              if (!hasChangedData) shouldSkip = true;
            } else {
              shouldSkip = true;
            }
            break;
          }
          case "epoch-changed": {
            if (requires2.length > 0) {
              const hasRefreshed = requires2.some((req) => {
                for (const [otherName, otherConfig] of Object.entries(graphTasks)) {
                  if (getProvides(otherConfig).includes(req)) {
                    const otherState = state.tasks[otherName];
                    if (otherState && otherState.executionCount > taskState.lastEpoch) return true;
                  }
                }
                return false;
              });
              if (!hasRefreshed) shouldSkip = true;
            } else {
              shouldSkip = true;
            }
            break;
          }
          case "time-based": {
            const interval = taskConfig.refreshInterval ?? 0;
            if (interval <= 0) {
              shouldSkip = true;
              break;
            }
            const completedAt = taskState.completedAt;
            if (!completedAt) {
              shouldSkip = true;
              break;
            }
            const elapsedSec = (Date.now() - Date.parse(completedAt)) / 1e3;
            if (elapsedSec < interval) shouldSkip = true;
            break;
          }
          case "manual":
            shouldSkip = true;
            break;
        }
        if (shouldSkip) continue;
      }
      const requires = getRequires(taskConfig);
      if (requires.length === 0) {
        eligible.push(taskName);
        continue;
      }
      const missingTokens = [];
      const pendingTokens = [];
      const failedTokenInfo = [];
      for (const token of requires) {
        if (availableOutputs.has(token)) continue;
        const producers = producerMap[token] || [];
        if (producers.length === 0) {
          missingTokens.push(token);
        } else {
          const allFailed = producers.every((p) => isNonActiveTask(state.tasks[p]));
          if (allFailed) {
            failedTokenInfo.push({ token, failedProducer: producers[0] });
          } else {
            pendingTokens.push(token);
          }
        }
      }
      if (missingTokens.length > 0) {
        unresolved.push({ taskName, missingTokens });
      } else if (failedTokenInfo.length > 0) {
        blocked.push({
          taskName,
          failedTokens: failedTokenInfo.map((f) => f.token),
          failedProducers: [...new Set(failedTokenInfo.map((f) => f.failedProducer))]
        });
      } else if (pendingTokens.length > 0) {
        pending.push({ taskName, waitingOn: pendingTokens });
      } else {
        eligible.push(taskName);
      }
    }
    const conflicts = {};
    if (eligible.length > 1) {
      const outputGroups = groupTasksByProvides(eligible, graphTasks);
      for (const [outputKey, groupTasks] of Object.entries(outputGroups)) {
        if (groupTasks.length > 1) {
          conflicts[outputKey] = groupTasks;
        }
      }
    }
    return { eligible, pending, unresolved, blocked, conflicts };
  }
  function buildProducerMap(tasks) {
    const map = {};
    for (const [name, config] of Object.entries(tasks)) {
      for (const token of getProvides(config)) {
        if (!map[token]) map[token] = [];
        map[token].push(name);
      }
      if (config.on) {
        for (const tokens of Object.values(config.on)) {
          for (const token of tokens) {
            if (!map[token]) map[token] = [];
            if (!map[token].includes(name)) map[token].push(name);
          }
        }
      }
      if (config.on_failure) {
        for (const token of config.on_failure) {
          if (!map[token]) map[token] = [];
          if (!map[token].includes(name)) map[token].push(name);
        }
      }
    }
    return map;
  }

  // src/continuous-event-graph/journal.ts
  var MemoryJournal = class {
    constructor() {
      __publicField(this, "buffer", []);
    }
    append(event) {
      this.buffer.push(event);
    }
    drain() {
      const events = this.buffer;
      this.buffer = [];
      return events;
    }
    get size() {
      return this.buffer.length;
    }
  };

  // src/continuous-event-graph/reactive.ts
  function computeDataHash(data) {
    const json = stableStringify(data);
    return fnv1a64Hex(json);
  }
  function stableStringify(value) {
    if (value === null || value === void 0 || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map(stableStringify).join(",") + "]";
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
  }
  function fnv1a64Hex(input) {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mod = 0xffffffffffffffffn;
    for (let i = 0; i < input.length; i++) {
      hash ^= BigInt(input.charCodeAt(i));
      hash = hash * prime & mod;
    }
    return hash.toString(16).padStart(16, "0");
  }
  function base64UrlEncode(input) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(input, "utf8").toString("base64url");
    }
    if (typeof btoa === "function") {
      const bytes = new TextEncoder().encode(input);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }
    throw new Error("No base64 encoder available in this runtime");
  }
  function base64UrlDecode(input) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(input, "base64url").toString("utf8");
    }
    if (typeof atob === "function") {
      const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    throw new Error("No base64 decoder available in this runtime");
  }
  function encodeCallbackToken(taskName) {
    const payload = JSON.stringify({ t: taskName, n: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
    return base64UrlEncode(payload);
  }
  function decodeCallbackToken(token) {
    try {
      const payload = JSON.parse(base64UrlDecode(token));
      if (typeof payload?.t === "string") return { taskName: payload.t };
      return null;
    } catch {
      return null;
    }
  }
  function createReactiveGraph(configOrLive, options, executionId) {
    const {
      handlers: initialHandlers,
      onDrain
    } = options;
    const inputQueue = new MemoryJournal();
    let live = "state" in configOrLive && "config" in configOrLive ? configOrLive : createLiveGraph(configOrLive, executionId);
    let disposed = false;
    const handlers = new Map(Object.entries(initialHandlers));
    const internalJournal = new MemoryJournal();
    let draining = false;
    let drainQueued = false;
    function drain() {
      if (disposed) return;
      if (draining) {
        drainQueued = true;
        return;
      }
      draining = true;
      try {
        do {
          drainQueued = false;
          drainOnce();
        } while (drainQueued);
      } finally {
        draining = false;
      }
    }
    function drainOnce() {
      const internalEvents = internalJournal.drain();
      const inputEvents = inputQueue.drain();
      const events = [...internalEvents, ...inputEvents];
      if (events.length > 0) {
        live = applyEvents(live, events);
      }
      const result = schedule(live);
      if (events.length > 0) {
        onDrain?.(events, live, result);
      }
      for (const taskName of result.eligible) {
        dispatchTask(taskName);
      }
      for (const event of events) {
        if (event.type === "task-progress") {
          const { taskName, update } = event;
          const taskConfig = live.config.tasks[taskName];
          if (!taskConfig) continue;
          const taskState = live.state.tasks[taskName];
          if (!taskState || taskState.status !== "running") continue;
          const callbackToken = encodeCallbackToken(taskName);
          runPipeline(taskName, callbackToken, update).catch((error) => {
            if (disposed) return;
            internalJournal.append({
              type: "task-failed",
              taskName,
              error: error.message ?? String(error),
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            });
            drain();
          });
        }
      }
    }
    function resolveUpstreamState(taskName) {
      const taskConfig = live.config.tasks[taskName];
      const requires = taskConfig.requires ?? [];
      const tokenToTask = /* @__PURE__ */ new Map();
      for (const [name, cfg] of Object.entries(live.config.tasks)) {
        for (const token of cfg.provides ?? []) {
          tokenToTask.set(token, name);
        }
      }
      const state = {};
      for (const token of requires) {
        const producerTask = tokenToTask.get(token);
        if (producerTask) {
          state[token] = live.state.tasks[producerTask]?.data;
        } else {
          state[token] = void 0;
        }
      }
      return state;
    }
    async function runPipeline(taskName, callbackToken, update) {
      const taskConfig = live.config.tasks[taskName];
      const handlerNames = taskConfig.taskHandlers ?? [];
      const upstreamState = resolveUpstreamState(taskName);
      for (const handlerName of handlerNames) {
        const handler = handlers.get(handlerName);
        if (!handler) {
          throw new Error(`Handler '${handlerName}' not found in registry (task '${taskName}')`);
        }
        const input = {
          nodeId: taskName,
          state: upstreamState,
          taskState: live.state.tasks[taskName],
          config: taskConfig,
          callbackToken,
          update
        };
        const status = await handler(input);
        if (status === "task-initiate-failure") {
          throw new Error(`Handler '${handlerName}' returned task-initiate-failure (task '${taskName}')`);
        }
      }
    }
    function dispatchTask(taskName) {
      const taskConfig = live.config.tasks[taskName];
      const handlerNames = taskConfig?.taskHandlers;
      if (!handlerNames || handlerNames.length === 0) {
        return;
      }
      internalJournal.append({
        type: "task-started",
        taskName,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
      drain();
      const callbackToken = encodeCallbackToken(taskName);
      runPipeline(taskName, callbackToken).catch((error) => {
        if (disposed) return;
        internalJournal.append({
          type: "task-failed",
          taskName,
          error: error.message ?? String(error),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        drain();
      });
    }
    return {
      push(event) {
        if (disposed) return;
        if (event.type === "task-completed" && event.data && !event.dataHash) {
          event = { ...event, dataHash: computeDataHash(event.data) };
        }
        inputQueue.append(event);
        drain();
      },
      pushAll(events) {
        if (disposed) return;
        for (const event of events) {
          if (event.type === "task-completed" && event.data && !event.dataHash) {
            inputQueue.append({ ...event, dataHash: computeDataHash(event.data) });
          } else {
            inputQueue.append(event);
          }
        }
        drain();
      },
      resolveCallback(callbackToken, data, errors) {
        if (disposed) return;
        const decoded = decodeCallbackToken(callbackToken);
        if (!decoded) return;
        const { taskName } = decoded;
        if (!live.config.tasks[taskName]) return;
        if (errors && errors.length > 0) {
          inputQueue.append({
            type: "task-failed",
            taskName,
            error: errors.join("; "),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
        } else {
          const dataHash = data && Object.keys(data).length > 0 ? computeDataHash(data) : void 0;
          inputQueue.append({
            type: "task-completed",
            taskName,
            data,
            dataHash,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        drain();
      },
      addNode(name, taskConfig) {
        if (disposed) return;
        inputQueue.append({ type: "task-upsert", taskName: name, taskConfig, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
        drain();
      },
      removeNode(name) {
        if (disposed) return;
        inputQueue.append({ type: "task-removal", taskName: name, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
        drain();
      },
      addRequires(nodeName, tokens) {
        if (disposed) return;
        inputQueue.append({ type: "node-requires-add", nodeName, tokens, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
        drain();
      },
      removeRequires(nodeName, tokens) {
        if (disposed) return;
        inputQueue.append({ type: "node-requires-remove", nodeName, tokens, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
        drain();
      },
      addProvides(nodeName, tokens) {
        if (disposed) return;
        inputQueue.append({ type: "node-provides-add", nodeName, tokens, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
        drain();
      },
      removeProvides(nodeName, tokens) {
        if (disposed) return;
        inputQueue.append({ type: "node-provides-remove", nodeName, tokens, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
        drain();
      },
      registerHandler(name, fn) {
        handlers.set(name, fn);
      },
      unregisterHandler(name) {
        handlers.delete(name);
      },
      retrigger(taskName) {
        if (disposed) return;
        if (!live.config.tasks[taskName]) return;
        inputQueue.append({
          type: "task-restart",
          taskName,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        drain();
      },
      retriggerAll(taskNames) {
        if (disposed) return;
        for (const name of taskNames) {
          if (!live.config.tasks[name]) continue;
          inputQueue.append({
            type: "task-restart",
            taskName: name,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        drain();
      },
      snapshot() {
        return snapshot(live);
      },
      getState() {
        return live;
      },
      getSchedule() {
        return schedule(live);
      },
      dispose() {
        disposed = true;
      }
    };
  }

  // src/board-livegraph-runtime/index.ts
  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function toTaskConfig(card) {
    const provides = card.provides && card.provides.length > 0 ? card.provides.map((p) => p.bindTo) : [card.id];
    return {
      requires: card.requires && card.requires.length > 0 ? [...card.requires] : void 0,
      provides,
      taskHandlers: [card.id],
      description: card.meta?.title ?? card.id
    };
  }
  function buildTokenProviders(cards) {
    const tokenToCardId = /* @__PURE__ */ new Map();
    for (const [cardId, card] of cards.entries()) {
      const bindings = card.provides && card.provides.length > 0 ? card.provides : [{ bindTo: cardId, src: "card_data" }];
      for (const binding of bindings) tokenToCardId.set(binding.bindTo, cardId);
    }
    return tokenToCardId;
  }
  function validateRequires(cards, changedCardId) {
    const tokenProviders = buildTokenProviders(cards);
    const card = cards.get(changedCardId);
    if (!card) return;
    for (const req of card.requires ?? []) {
      if (!tokenProviders.has(req)) {
        throw new Error(`Card "${changedCardId}" requires token "${req}" but no card provides it`);
      }
    }
  }
  var LocalStorageService = {
    // Keys
    CARD_PREFIX: "yf:cards:",
    RUNTIME_OUT_PREFIX: "yf:runtime-out:cards:",
    STATUS_KEY: "yf:runtime-out:status",
    // Read/write cards (mirrors tmp/cards/<id>.json)
    writeCard(cardId, cardObject) {
      try {
        localStorage.setItem(this.CARD_PREFIX + cardId, JSON.stringify(cardObject));
      } catch (e) {
        console.warn(`Failed to write card ${cardId} to localStorage:`, e);
      }
    },
    readCard(cardId) {
      try {
        const raw = localStorage.getItem(this.CARD_PREFIX + cardId);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.warn(`Failed to read card ${cardId} from localStorage:`, e);
        return null;
      }
    },
    readAllCards(cardIds) {
      const result = {};
      for (const id of cardIds) {
        const card = this.readCard(id);
        if (card) result[id] = card;
      }
      return result;
    },
    // Read/write computed artifacts (mirrors runtime-out/cards/<id>.computed.json)
    writeComputedArtifact(artifact) {
      if (!artifact || !artifact.card_id) return;
      try {
        localStorage.setItem(
          this.RUNTIME_OUT_PREFIX + String(artifact.card_id),
          JSON.stringify(artifact)
        );
      } catch (e) {
        console.warn(`Failed to write computed artifact ${artifact.card_id}:`, e);
      }
    },
    readComputedArtifact(cardId) {
      try {
        const raw = localStorage.getItem(this.RUNTIME_OUT_PREFIX + cardId);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.warn(`Failed to read computed artifact ${cardId}:`, e);
        return null;
      }
    },
    readAllComputedArtifacts(cardIds) {
      const result = {};
      for (const id of cardIds) {
        const artifact = this.readComputedArtifact(id);
        if (artifact) result[id] = artifact;
      }
      return result;
    },
    // Read/write board status snapshot (mirrors runtime-out/board-livegraph-status.json)
    writeStatusSnapshot(snapshot2) {
      try {
        localStorage.setItem(this.STATUS_KEY, JSON.stringify(snapshot2));
      } catch (e) {
        console.warn("Failed to write status snapshot to localStorage:", e);
      }
    },
    readStatusSnapshot() {
      try {
        const raw = localStorage.getItem(this.STATUS_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.warn("Failed to read status snapshot from localStorage:", e);
        return null;
      }
    },
    // Clear all (useful for reset/demo)
    clear() {
      const keysToDelete = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith(this.CARD_PREFIX) || key.startsWith(this.RUNTIME_OUT_PREFIX) || key === this.STATUS_KEY)) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        localStorage.removeItem(key);
      }
    }
  };
  function createBoardLiveGraphRuntime(input, options = {}) {
    const boardMeta = Array.isArray(input) ? {} : {
      id: input.id,
      title: input.title,
      mode: input.mode,
      positions: input.positions,
      settings: input.settings
    };
    const initialCards = Array.isArray(input) ? input : input.nodes;
    const cards = /* @__PURE__ */ new Map();
    for (const card of initialCards) {
      if (cards.has(card.id)) throw new Error(`Duplicate card ID: "${card.id}"`);
      cards.set(card.id, deepClone(card));
    }
    const listeners = /* @__PURE__ */ new Set();
    const taskExecutor = options.taskExecutor;
    const sourceAdapters = options.sourceAdapters ?? {};
    const defaultSourceAdapter = options.defaultSourceAdapter;
    let graphRef = null;
    const notifyListeners = (events, graph2) => {
      const update = {
        events,
        graph: graph2,
        nodes: getRenderableNodes()
      };
      for (const listener of listeners) listener(update);
    };
    const makeHandler = (cardId) => {
      return async (inputArgs) => {
        const card = cards.get(cardId);
        if (!card) return "task-initiate-failure";
        const requiresData = {};
        for (const token of card.requires ?? []) {
          const upstream = inputArgs.state[token];
          if (!upstream) continue;
          requiresData[token] = Object.prototype.hasOwnProperty.call(upstream, token) ? upstream[token] : upstream;
        }
        const sourcesData = {};
        if (card.sources && card.sources.length > 0) {
          const adapter = sourceAdapters[cardId] ?? defaultSourceAdapter;
          const fetched = taskExecutor ? await taskExecutor({ card, input: inputArgs }) : adapter ? await adapter({ card, input: inputArgs }) : void 0;
          if (fetched && typeof fetched === "object") {
            for (const src of card.sources) {
              if (Object.prototype.hasOwnProperty.call(fetched, src.bindTo)) {
                sourcesData[src.bindTo] = fetched[src.bindTo];
              } else if (card.sources.length === 1) {
                sourcesData[src.bindTo] = fetched;
              }
            }
          }
        }
        const computeNode = {
          id: card.id,
          card_data: deepClone(card.card_data ?? {}),
          requires: requiresData,
          sources: card.sources,
          compute: card.compute
        };
        computeNode._sourcesData = sourcesData;
        if (computeNode.compute && computeNode.compute.length > 0) {
          await CardCompute.run(computeNode, { sourcesData });
        }
        let resultData;
        if (card.provides && card.provides.length > 0) {
          resultData = {};
          for (const { bindTo, src } of card.provides) {
            resultData[bindTo] = CardCompute.resolve(computeNode, src);
          }
        } else {
          resultData = {
            ...computeNode.card_data ?? {},
            ...computeNode.computed_values ?? {},
            ...computeNode._sourcesData ?? {}
          };
        }
        resultData.__cardData = computeNode.card_data ?? {};
        if (computeNode.computed_values) resultData.__computed_values = computeNode.computed_values;
        if (Object.keys(sourcesData).length > 0) resultData.__sourcesData = sourcesData;
        if (Object.keys(requiresData).length > 0) resultData.__requiresData = requiresData;
        graphRef?.resolveCallback(inputArgs.callbackToken, resultData);
        return "task-initiated";
      };
    };
    const tasks = {};
    const handlers = {};
    for (const [cardId, card] of cards.entries()) {
      validateRequires(cards, cardId);
      tasks[cardId] = toTaskConfig(card);
      handlers[cardId] = makeHandler(cardId);
    }
    const config = {
      id: boardMeta.id ?? `browser-board-${Date.now()}`,
      settings: {
        completion: "manual",
        execution_mode: "eligibility-mode",
        ...boardMeta.settings ?? {},
        ...options.graphSettings ?? {}
      },
      tasks
    };
    const userOnDrain = options.reactiveOptions?.onDrain;
    const graph = createReactiveGraph(
      config,
      {
        ...options.reactiveOptions ?? {},
        handlers,
        onDrain: (events, live, scheduleResult) => {
          userOnDrain?.(events, live, scheduleResult);
          notifyListeners(events, live);
        }
      },
      options.executionId
    );
    graphRef = graph;
    function getRenderableNodes() {
      const live = graph.getState();
      const out = [];
      for (const [cardId, baseCard] of cards.entries()) {
        const node = deepClone(baseCard);
        const data = live.state.tasks[cardId]?.data;
        const mergedCardData = {
          ...node.card_data ?? {},
          ...data && typeof data.__cardData === "object" ? data.__cardData : {}
        };
        node.card_data = mergedCardData;
        const runtimeState = live.state.tasks[cardId];
        if (runtimeState?.status != null || runtimeState?.lastUpdated != null || runtimeState?.error != null) {
          node.card_data = {
            ...node.card_data,
            status: runtimeState.status === "running" ? "loading" : runtimeState.status,
            lastRun: runtimeState.lastUpdated ?? node.card_data.lastRun,
            ...runtimeState.status === "failed" && runtimeState.error ? { error: runtimeState.error } : {}
          };
        }
        if (data && typeof data.__computed_values === "object") {
          node.computed_values = data.__computed_values;
        }
        if (data && typeof data.__sourcesData === "object") {
          const renderNode = node;
          renderNode._sourcesData = data.__sourcesData;
          renderNode.sources = data.__sourcesData;
        }
        if (data && typeof data.__requiresData === "object") {
          const renderNode = node;
          renderNode.requires = data.__requiresData;
        }
        out.push(node);
      }
      return out;
    }
    const runtime = {
      getGraph: () => graph,
      getState: () => graph.getState(),
      getSchedule: () => graph.getSchedule(),
      getNodes: () => getRenderableNodes(),
      getBoard: () => ({
        ...boardMeta,
        nodes: getRenderableNodes()
      }),
      subscribe(listener) {
        listeners.add(listener);
        listener({ events: [], graph: graph.getState(), nodes: getRenderableNodes() });
        return () => listeners.delete(listener);
      },
      addCard(card) {
        if (cards.has(card.id)) throw new Error(`Card "${card.id}" already exists`);
        cards.set(card.id, deepClone(card));
        validateRequires(cards, card.id);
        graph.registerHandler(card.id, makeHandler(card.id));
        graph.addNode(card.id, toTaskConfig(card));
      },
      upsertCard(card) {
        cards.set(card.id, deepClone(card));
        validateRequires(cards, card.id);
        graph.registerHandler(card.id, makeHandler(card.id));
        graph.addNode(card.id, toTaskConfig(card));
      },
      removeCard(cardId) {
        cards.delete(cardId);
        graph.unregisterHandler(cardId);
        graph.removeNode(cardId);
      },
      patchCardState(cardId, patch) {
        const card = cards.get(cardId);
        if (!card) throw new Error(`Card "${cardId}" not found`);
        card.card_data = { ...card.card_data ?? {}, ...patch };
        graph.retrigger(cardId);
      },
      retrigger(cardId) {
        graph.retrigger(cardId);
      },
      retriggerAll() {
        graph.retriggerAll(Array.from(cards.keys()));
      },
      push(event) {
        graph.push(event);
      },
      pushAll(events) {
        graph.pushAll(events);
      },
      dispose() {
        listeners.clear();
        graph.dispose();
      }
    };
    return runtime;
  }

  exports.LocalStorageService = LocalStorageService;
  exports.createBoardLiveGraphRuntime = createBoardLiveGraphRuntime;

  return exports;

})({});
//# sourceMappingURL=board-livegraph-runtime.js.map
//# sourceMappingURL=board-livegraph-runtime.js.map