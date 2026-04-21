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

function normalizeCardRuntimeArtifact(cardId, artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return {
      schema_version: 'v1',
      card_id: cardId,
      card_data: {},
      computed_values: {},
      sources_data: {},
    };
  }

  const cardData = artifact.card_data && typeof artifact.card_data === 'object' && !Array.isArray(artifact.card_data)
    ? clone(artifact.card_data)
    : {};

  const computedValues = artifact.computed_values && typeof artifact.computed_values === 'object' && !Array.isArray(artifact.computed_values)
    ? clone(artifact.computed_values)
    : {};

  const sourcesData = artifact.sources_data && typeof artifact.sources_data === 'object' && !Array.isArray(artifact.sources_data)
    ? clone(artifact.sources_data)
    : {};

  return {
    schema_version: artifact.schema_version || 'v1',
    card_id: typeof artifact.card_id === 'string' ? artifact.card_id : cardId,
    card_data: cardData,
    computed_values: computedValues,
    sources_data: sourcesData,
  };
}

function buildRenderableCardsFromArtifacts({ cardDefinitions, statusSnapshot, cardRuntimeById, dataObjectsByToken }) {
  const safeCardDefinitions = Array.isArray(cardDefinitions) ? cardDefinitions : [];
  const safeCardRuntimeById = cardRuntimeById && typeof cardRuntimeById === 'object' ? cardRuntimeById : {};
  const safeDataObjectsByToken = dataObjectsByToken && typeof dataObjectsByToken === 'object'
    ? dataObjectsByToken
    : {};
  const statusCards = Array.isArray(statusSnapshot && statusSnapshot.cards) ? statusSnapshot.cards : [];
  const statusById = new Map(statusCards.map((card) => [card.name, card]));

  return safeCardDefinitions.map((cardDefinition) => {
    const node = clone(cardDefinition);
    const statusCard = statusById.get(node.id);
    const runtimeArtifact = normalizeCardRuntimeArtifact(node.id, safeCardRuntimeById[node.id]);

    const cardData = {
      ...(node.card_data || {}),
      ...(runtimeArtifact.card_data || {}),
    };

    cardData.status = taskStatusToCardStatus(statusCard && statusCard.status);
    cardData.lastRun =
      (statusCard && statusCard.runtime && statusCard.runtime.last_transition_at) ||
      null;

    if (statusCard && statusCard.error && statusCard.error.message) {
      cardData.error = statusCard.error.message;
    } else {
      delete cardData.error;
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
          runtime: {
            last_transition_at: cardData.lastRun || null,
          },
          error: cardData.error ? { message: cardData.error } : null,
          blocked_by: [],
          requires_missing: [],
        };

    node.card_data = cardData;
    node.runtime_state = runtimeState;
    node._sourcesData = runtimeArtifact.sources_data || {};
    node.sources = runtimeArtifact.sources_data || node.sources || {};

    // Resolve token payloads from the shared data-objects map into the
    // `requires` namespace that compute expressions reference (requires.orders.*).
    // Keep the original requires array intact on `_requiresTokens` so the
    // browser engine can still use it for pub/sub subscription wiring.
    const resolvedRequiresData = {};
    for (const token of Array.isArray(cardDefinition.requires) ? cardDefinition.requires : []) {
      if (Object.prototype.hasOwnProperty.call(safeDataObjectsByToken, token)) {
        resolvedRequiresData[token] = clone(safeDataObjectsByToken[token]);
      }
    }
    node.data_objects = clone(safeDataObjectsByToken);
    // `requires` as object is what compute exprs read (requires.orders.amount).
    // `_requiresTokens` preserves the original array for the engine pub/sub.
    node._requiresTokens = Array.isArray(cardDefinition.requires) ? cardDefinition.requires : [];
    node.requires = resolvedRequiresData;

    // Seed computed_values from the server-side snapshot.  The browser will
    // re-run compute immediately after mounting, overwriting this with fresh
    // values derived from the resolved requires data above.
    node.computed_values = runtimeArtifact.computed_values || {};

    return node;
  });
}

function buildBrowserArtifactsFromRuntime({ boardPath, cardDefinitions, runtimeNodes, graphState }) {
  const safeCardDefinitions = Array.isArray(cardDefinitions) ? cardDefinitions : [];
  const safeRuntimeNodes = Array.isArray(runtimeNodes) ? runtimeNodes : [];
  const runtimeNodesById = new Map(safeRuntimeNodes.map((node) => [node.id, node]));
  const taskStates = graphState && graphState.state && graphState.state.tasks ? graphState.state.tasks : {};

  const cardRuntimeById = {};
  for (const runtimeNode of safeRuntimeNodes) {
    if (!runtimeNode || !runtimeNode.id) continue;
    cardRuntimeById[runtimeNode.id] = {
      schema_version: 'v1',
      card_id: runtimeNode.id,
      card_data: clone(runtimeNode.card_data || {}),
      computed_values: clone(runtimeNode.computed_values || {}),
      sources_data: clone(runtimeNode._sourcesData || runtimeNode.sources || {}),
      requires_data: clone(runtimeNode.requires || {}),
    };
  }

  const statusCards = safeCardDefinitions.map((cardDefinition) => {
    const runtimeNode = runtimeNodesById.get(cardDefinition.id) || {};
    const taskState = taskStates[cardDefinition.id] || {};
    const taskStatus = typeof taskState.status === 'string'
      ? taskState.status
      : cardStatusToTaskStatus(runtimeNode.card_data && runtimeNode.card_data.status);

    const errorMessage = typeof taskState.error === 'string'
      ? taskState.error
      : runtimeNode.card_data && typeof runtimeNode.card_data.error === 'string'
        ? runtimeNode.card_data.error
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
      provides_runtime: Object.keys((runtimeNode && runtimeNode.computed_values) || {}).sort(),
      blocked_by: [],
      unblocks: [],
      runtime: {
        attempt_count: taskState.executionCount || 0,
        restart_count: taskState.retryCount || 0,
        in_progress_since: taskStatus === 'in-progress' ? (taskState.startedAt || null) : null,
        last_transition_at: taskState.lastUpdated || (runtimeNode.card_data && runtimeNode.card_data.lastRun) || null,
        last_completed_at: taskState.completedAt || null,
        last_restarted_at: taskState.startedAt || null,
        status_age_ms: null,
      },
    };
  });

  return {
    cardDefinitions: clone(safeCardDefinitions),
    cardRuntimeById,
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
