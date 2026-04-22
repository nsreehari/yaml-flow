function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function taskStatusToCardStatus(taskStatus) {
  if (taskStatus === 'running' || taskStatus === 'in-progress') return 'loading';
  if (taskStatus === 'failed') return 'error';
  if (taskStatus === 'completed') return 'fresh';
  return 'fresh';
}

function cardStatusToTaskStatus(cardStatus) {
  if (cardStatus === 'loading') return 'in-progress';
  if (cardStatus === 'error') return 'failed';
  if (cardStatus === 'stale') return 'pending';
  if (cardStatus === 'fresh') return 'completed';
  return 'pending';
}

function ensureObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function normalizeCardRuntimeArtifact(cardId, artifact) {
  const safeArtifact = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
    ? artifact
    : {};

  const cardData = safeArtifact.card_data && typeof safeArtifact.card_data === 'object' && !Array.isArray(safeArtifact.card_data)
    ? clone(safeArtifact.card_data)
    : {};

  const computedValues = safeArtifact.computed_values && typeof safeArtifact.computed_values === 'object' && !Array.isArray(safeArtifact.computed_values)
    ? clone(safeArtifact.computed_values)
    : {};

  const fetchedSources = safeArtifact.fetched_sources && typeof safeArtifact.fetched_sources === 'object' && !Array.isArray(safeArtifact.fetched_sources)
    ? clone(safeArtifact.fetched_sources)
    : {};

  const requiresData = safeArtifact.requires && typeof safeArtifact.requires === 'object' && !Array.isArray(safeArtifact.requires)
    ? clone(safeArtifact.requires)
    : {};

  return {
    schema_version: safeArtifact.schema_version || 'v1',
    card_id: typeof safeArtifact.card_id === 'string' ? safeArtifact.card_id : cardId,
    card_data: cardData,
    computed_values: computedValues,
    fetched_sources: fetchedSources,
    requires: requiresData,
  };
}

function resolveRequiresData(cardDefinition, dataObjectsByToken) {
  const resolved = {};
  const tokens = Array.isArray(cardDefinition && cardDefinition.requires) ? cardDefinition.requires : [];
  const safeObjects = dataObjectsByToken && typeof dataObjectsByToken === 'object' && !Array.isArray(dataObjectsByToken)
    ? dataObjectsByToken
    : {};

  for (const token of tokens) {
    if (!Object.prototype.hasOwnProperty.call(safeObjects, token)) continue;
    resolved[token] = clone(safeObjects[token]);
  }

  return resolved;
}

function buildLiveCardModelsFromArtifacts(payload) {
  const safePayload = ensureObject(payload, 'payload');
  const cardDefinitions = Array.isArray(safePayload.cardDefinitions) ? safePayload.cardDefinitions : [];
  const statusSnapshot = safePayload.statusSnapshot && typeof safePayload.statusSnapshot === 'object' ? safePayload.statusSnapshot : {};
  const cardRuntimeById = safePayload.cardRuntimeById && typeof safePayload.cardRuntimeById === 'object' ? safePayload.cardRuntimeById : {};
  const dataObjectsByToken = safePayload.dataObjectsByToken && typeof safePayload.dataObjectsByToken === 'object' ? safePayload.dataObjectsByToken : {};
  const statusCards = Array.isArray(statusSnapshot.cards) ? statusSnapshot.cards : [];
  const statusById = new Map(statusCards.map((card) => [card.name, card]));

  return cardDefinitions.map((cardDefinition) => {
    const card = clone(cardDefinition);
    const cardId = card && card.id;
    if (!cardId) throw new Error('cardDefinitions entry missing id');

    const statusCard = statusById.get(cardId);
    const runtimeArtifact = normalizeCardRuntimeArtifact(cardId, cardRuntimeById[cardId]);

    const cardData = {
      ...((card.card_data && typeof card.card_data === 'object' && !Array.isArray(card.card_data)) ? card.card_data : {}),
      ...(runtimeArtifact.card_data || {}),
      status: taskStatusToCardStatus(statusCard && statusCard.status),
      lastRun: (statusCard && statusCard.runtime && statusCard.runtime.last_transition_at) || null,
    };

    if (statusCard && statusCard.error && statusCard.error.message) {
      cardData.error = statusCard.error.message;
    }

    const runtimeState = statusCard
      ? {
          task_status: statusCard.status || null,
          card_status: taskStatusToCardStatus(statusCard.status),
          runtime: clone(statusCard.runtime || {}),
          error: statusCard.error ? clone(statusCard.error) : null,
          blocked_by: Array.isArray(statusCard.blocked_by) ? clone(statusCard.blocked_by) : [],
          requires_missing: Array.isArray(statusCard.requires_missing) ? clone(statusCard.requires_missing) : [],
        }
      : {
          task_status: null,
          card_status: cardData.status || 'fresh',
          runtime: { last_transition_at: cardData.lastRun || null },
          error: cardData.error ? { message: cardData.error } : null,
          blocked_by: [],
          requires_missing: [],
        };

    return {
      id: cardId,
      card,
      card_data: cardData,
      fetched_sources: runtimeArtifact.fetched_sources || {},
      requires: resolveRequiresData(card, dataObjectsByToken),
      computed_values: runtimeArtifact.computed_values || {},
      runtime_state: runtimeState,
      data_objects: clone(dataObjectsByToken),
    };
  });
}

function buildBrowserArtifactsFromRuntime({ boardPath, cardDefinitions, runtimeModels, graphState }) {
  const safeCardDefinitions = Array.isArray(cardDefinitions) ? cardDefinitions : [];
  const safeRuntimeModels = Array.isArray(runtimeModels) ? runtimeModels : [];
  const runtimeModelById = new Map(safeRuntimeModels.map((model) => [model.id, model]));
  const taskStates = graphState && graphState.state && graphState.state.tasks ? graphState.state.tasks : {};

  const cardRuntimeById = {};
  for (const model of safeRuntimeModels) {
    if (!model || !model.id) continue;
    cardRuntimeById[model.id] = {
      schema_version: 'v1',
      card_id: model.id,
      card_data: clone(model.card_data || {}),
      computed_values: clone(model.computed_values || {}),
      fetched_sources: clone(model.fetched_sources || {}),
      requires: clone(model.requires || {}),
    };
  }

  const dataObjectsByToken = {};
  for (const taskName of Object.keys(taskStates)) {
    const taskState = taskStates[taskName] || {};
    const taskData = taskState.data && typeof taskState.data === 'object' ? taskState.data : {};
    const providesData = taskData.provides_data && typeof taskData.provides_data === 'object'
      ? taskData.provides_data
      : {};

    for (const token of Object.keys(providesData)) {
      dataObjectsByToken[token] = clone(providesData[token]);
    }
  }

  const statusCards = safeCardDefinitions.map((cardDefinition) => {
    const runtimeModel = runtimeModelById.get(cardDefinition.id) || {};
    const taskState = taskStates[cardDefinition.id] || {};
    const taskStatus = typeof taskState.status === 'string'
      ? taskState.status
      : cardStatusToTaskStatus(runtimeModel.card_data && runtimeModel.card_data.status);

    const errorMessage = typeof taskState.error === 'string'
      ? taskState.error
      : runtimeModel.card_data && typeof runtimeModel.card_data.error === 'string'
        ? runtimeModel.card_data.error
        : null;

    return {
      name: cardDefinition.id,
      status: taskStatus,
      error: errorMessage ? {
        message: errorMessage,
        code: 'TASK_FAILED',
        at: taskState.failedAt || null,
        source: 'browser-runtime',
      } : undefined,
      requires: Array.isArray(cardDefinition.requires) ? cardDefinition.requires : [],
      requires_satisfied: [],
      requires_missing: [],
      provides_declared: Array.isArray(cardDefinition.provides)
        ? cardDefinition.provides.map((entry) => entry.bindTo)
        : [cardDefinition.id],
      provides_runtime: Object.keys((taskState.data && taskState.data.provides_data) || {}).sort(),
      blocked_by: [],
      unblocks: [],
      runtime: {
        attempt_count: taskState.executionCount || 0,
        restart_count: taskState.retryCount || 0,
        in_progress_since: taskStatus === 'in-progress' ? (taskState.startedAt || null) : null,
        last_transition_at: taskState.lastUpdated || (runtimeModel.card_data && runtimeModel.card_data.lastRun) || null,
        last_completed_at: taskState.completedAt || null,
        last_restarted_at: taskState.startedAt || null,
        status_age_ms: null,
      },
    };
  });

  return {
    cardDefinitions: clone(safeCardDefinitions),
    cardRuntimeById,
    dataObjectsByToken,
    statusSnapshot: {
      schema_version: 'v1',
      meta: { board: { path: boardPath || 'browser-runtime' } },
      summary: {
        card_count: statusCards.length,
        completed: statusCards.filter((card) => card.status === 'completed').length,
        eligible: 0,
        pending: statusCards.filter((card) => card.status === 'pending').length,
        blocked: 0,
        unresolved: 0,
        failed: statusCards.filter((card) => card.status === 'failed').length,
        in_progress: statusCards.filter((card) => card.status === 'in-progress').length,
        orphan_cards: 0,
        topology: {
          edge_count: 0,
          max_fan_out_card: null,
          max_fan_out: 0,
        },
      },
      cards: statusCards,
    },
  };
}
