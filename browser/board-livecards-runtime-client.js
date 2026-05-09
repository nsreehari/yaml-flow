(function () {
  // ---------------------------------------------------------------------------
  // Pure helpers (same as demo-shell-localstorage)
  // ---------------------------------------------------------------------------

  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function stableEq(prev, next) {
    if (prev === next) return prev;
    try { if (JSON.stringify(prev) === JSON.stringify(next)) return prev; } catch (_) {}
    return next;
  }

  function deepEqJson(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
  }

  function taskStatusToCardStatus(taskStatus) {
    return (taskStatus === 'running' || taskStatus === 'in-progress')
      ? 'loading'
      : (taskStatus === 'failed' ? 'error' : 'fresh');
  }

  // ---------------------------------------------------------------------------
  // buildBoardState — build full reactive state from a runtime payload snapshot
  // ---------------------------------------------------------------------------

  function buildBoardState(payload, prevState, selectLiveCardModel) {
    var cardDefs = (payload && Array.isArray(payload.cardDefinitions)) ? payload.cardDefinitions : [];
    var cardIds = cardDefs.map(function (c) { return c.id; });
    var modelsById = {};
    var prevModels = (prevState && prevState.modelsById) || {};
    for (var i = 0; i < cardIds.length; i++) {
      var id = cardIds[i];
      var fresh = selectLiveCardModel(payload, id);
      var prev = prevModels[id];
      if (!prev) { modelsById[id] = fresh; continue; }
      var stab = {
        id: fresh.id,
        card: stableEq(prev.card, fresh.card),
        card_data: stableEq(prev.card_data, fresh.card_data),
        requires: stableEq(prev.requires, fresh.requires),
        computed_values: stableEq(prev.computed_values, fresh.computed_values),
        runtime_state: stableEq(prev.runtime_state, fresh.runtime_state),
      };
      if (stab.card === prev.card && stab.card_data === prev.card_data
        && stab.requires === prev.requires && stab.computed_values === prev.computed_values
        && stab.runtime_state === prev.runtime_state) {
        modelsById[id] = prev;
      } else {
        modelsById[id] = stab;
      }
    }
    return { payload: payload, cardIds: cardIds, modelsById: modelsById };
  }

  // ---------------------------------------------------------------------------
  // applyNotification — incremental state reducer (same as demo-shell-localstorage)
  // ---------------------------------------------------------------------------

  function applyNotification(prevState, notifications, selectLiveCardModel, getFullPayload) {
    if (!prevState || !Array.isArray(notifications) || notifications.length === 0) return prevState;

    var modelsById = prevState.modelsById;
    var cardIds = prevState.cardIds;
    var cloned = false;
    var changed = false;

    var consumersByToken = {};
    for (var i = 0; i < cardIds.length; i++) {
      var m = modelsById[cardIds[i]];
      var reqs = m && m.requires;
      if (reqs && typeof reqs === 'object') {
        var keys = Object.keys(reqs);
        for (var k = 0; k < keys.length; k++) {
          var t = keys[k];
          (consumersByToken[t] = consumersByToken[t] || []).push(cardIds[i]);
        }
      }
    }

    function ensureClone() {
      if (!cloned) { modelsById = Object.assign({}, modelsById); cloned = true; }
    }

    for (var n = 0; n < notifications.length; n++) {
      var note = notifications[n];
      if (!note || !note.kind) continue;

      if (note.kind === 'computed_values') {
        var prev = modelsById[note.cardId];
        if (!prev) continue;
        var nextValues = note.values || {};
        if (deepEqJson(prev.computed_values, nextValues)) continue;
        ensureClone();
        modelsById[note.cardId] = Object.assign({}, prev, { computed_values: nextValues });
        changed = true;
      } else if (note.kind === 'data_object') {
        var consumers = consumersByToken[note.key] || [];
        for (var c = 0; c < consumers.length; c++) {
          var cid = consumers[c];
          var prevC = modelsById[cid];
          if (!prevC) continue;
          var prevReqs = prevC.requires || {};
          if (deepEqJson(prevReqs[note.key], note.payload)) continue;
          ensureClone();
          var nextReqs = Object.assign({}, prevReqs);
          nextReqs[note.key] = note.payload;
          modelsById[cid] = Object.assign({}, prevC, { requires: nextReqs });
          changed = true;
        }
      } else if (note.kind === 'card_refreshed') {
        var fresh = null;
        try {
          var fp = getFullPayload();
          if (fp && selectLiveCardModel) fresh = selectLiveCardModel(fp, note.cardId);
        } catch (_) {}
        if (!fresh) continue;
        var existing = modelsById[note.cardId];
        if (existing
          && deepEqJson(existing.card, fresh.card)
          && deepEqJson(existing.card_data, fresh.card_data)
          && deepEqJson(existing.requires, fresh.requires)
          && deepEqJson(existing.computed_values, fresh.computed_values)
          && deepEqJson(existing.runtime_state, fresh.runtime_state)) {
          continue;
        }
        ensureClone();
        modelsById[note.cardId] = fresh;
        if (cardIds.indexOf(note.cardId) === -1) cardIds = cardIds.concat([note.cardId]);
        changed = true;
      } else if (note.kind === 'status') {
        var statusCards = note.status && Array.isArray(note.status.cards) ? note.status.cards : [];
        for (var sc = 0; sc < statusCards.length; sc++) {
          var statusCard = statusCards[sc];
          var sid = statusCard && statusCard.name;
          if (!sid || !modelsById[sid]) continue;

          var prevS = modelsById[sid];
          var nextCardStatus = taskStatusToCardStatus(statusCard.status);
          var nextCardData = Object.assign({}, prevS.card_data || {}, {
            status: nextCardStatus,
            lastRun: statusCard.runtime && statusCard.runtime.last_transition_at
              ? statusCard.runtime.last_transition_at
              : null,
          });
          if (statusCard.error && statusCard.error.message) nextCardData.error = statusCard.error.message;
          else delete nextCardData.error;

          var nextRuntimeState = {
            task_status: statusCard.status || null,
            card_status: nextCardStatus,
            runtime: statusCard.runtime ? clone(statusCard.runtime) : {},
            error: statusCard.error ? clone(statusCard.error) : null,
            blocked_by: Array.isArray(statusCard.blocked_by) ? clone(statusCard.blocked_by) : [],
            requires_missing: Array.isArray(statusCard.requires_missing) ? clone(statusCard.requires_missing) : [],
          };

          if (deepEqJson(prevS.card_data, nextCardData) && deepEqJson(prevS.runtime_state, nextRuntimeState)) {
            continue;
          }
          ensureClone();
          modelsById[sid] = Object.assign({}, prevS, {
            card_data: nextCardData,
            runtime_state: nextRuntimeState,
          });
          changed = true;
        }
      }
    }

    if (!changed) return prevState;
    return { payload: prevState.payload, cardIds: cardIds, modelsById: modelsById };
  }

  function createBoardRuntimeClient(options) {
    if (!options || typeof options !== 'object') {
      throw new Error('options are required');
    }

    const fetchServer = options.fetchServer;
    const boardPaths = options.boardPaths;
    const selectAllLiveCardModels = options.selectAllLiveCardModels
      || (typeof window !== 'undefined' && window.BoardLiveGraph && window.BoardLiveGraph.selectAllLiveCardModels);
    const selectLiveCardModelFn = options.selectLiveCardModel
      || (typeof window !== 'undefined' && window.BoardLiveGraph && window.BoardLiveGraph.selectLiveCardModel);
    const getServerOrigin = options.getServerOrigin;

    if (typeof fetchServer !== 'function') throw new Error('options.fetchServer is required');
    if (typeof boardPaths !== 'function') throw new Error('options.boardPaths is required');
    if (typeof selectAllLiveCardModels !== 'function') {
      throw new Error('options.selectAllLiveCardModels is required (or load board-livegraph-engine.js first)');
    }
    if (typeof getServerOrigin !== 'function') throw new Error('options.getServerOrigin is required');

    // Reactive state — single source of truth for the board
    let stateRef = { current: null };
    let board = null;
    let sse = null;
    let currentMode = String(options.initialMode || 'board');
    const canvas = options.canvas && typeof options.canvas === 'object'
      ? options.canvas
      : { height: '72vh', overflow: 'auto' };

    function getFullPayload() {
      return stateRef.current && stateRef.current.payload;
    }

    async function uploadCardFile(boardId, cardId, file, opts) {
      if (!file) return null;
      const optionsObj = opts && typeof opts === 'object' ? opts : {};
      const inChat = optionsObj.inChat === true;
      const fileName = typeof file.name === 'string' ? file.name : 'upload.bin';
      const contentType = file.type || 'application/octet-stream';
      const paths = boardPaths(boardId);
      const uploadPath = inChat
        ? `${paths.cardFile(cardId)}?inChat=true`
        : paths.cardFile(cardId);

      const upload = await fetchServer(uploadPath, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          'x-file-name': encodeURIComponent(fileName),
        },
        body: file,
      });

      if (!upload.ok) {
        const errText = await upload.text();
        throw new Error(`Upload failed (${upload.status}): ${errText || 'unknown error'}`);
      }

      const payload = await upload.json();
      return payload && payload.file ? payload.file : null;
    }

    async function uploadActionFiles(boardId, cardId, actionType, payload) {
      if (actionType !== 'chat-send' && actionType !== 'file-upload') return payload || {};
      const nextPayload = { ...(payload || {}) };
      const rawFiles = Array.isArray(nextPayload.files) ? nextPayload.files : [];
      if (!rawFiles.length) {
        nextPayload.files = [];
        return nextPayload;
      }

      const uploaded = [];
      for (const file of rawFiles) {
        const fileMeta = await uploadCardFile(boardId, cardId, file, { inChat: actionType === 'chat-send' });
        if (fileMeta) uploaded.push(fileMeta);
      }

      // For chat uploads, server-side file API already records file metadata and emits system chat logs.
      nextPayload.files = actionType === 'chat-send' ? [] : uploaded;
      return nextPayload;
    }

    async function bootstrapBoard(params) {
      const p = params && typeof params === 'object' ? params : {};
      const boardId = String(p.boardId || 'default');
      const taskExecutorPath = typeof p.taskExecutorPath === 'string' ? p.taskExecutorPath.trim() : '';
      const mode = String(p.mode || currentMode || 'board');
      const rootEl = p.rootElement;
      if (!rootEl) throw new Error('bootstrapBoard requires params.rootElement');

      const paths = boardPaths(boardId);

      const initBoardPath = taskExecutorPath
        ? `${paths.initBoard}?taskExecutorPath=${encodeURIComponent(taskExecutorPath)}`
        : paths.initBoard;
      const initBoardRes = await fetchServer(initBoardPath);
      if (!initBoardRes.ok) throw new Error(`Server init-board failed (${initBoardRes.status}).`);

      const bootstrapCardsRes = await fetchServer(paths.bootstrapCards);
      if (!bootstrapCardsRes.ok) {
        throw new Error(`Server bootstrap-cards failed (${bootstrapCardsRes.status}).`);
      }

      const payload = await bootstrapCardsRes.json();
      if (!selectAllLiveCardModels(payload)) throw new Error('Server payload missing published runtime artifacts');

      // Resolve selectLiveCardModel — prefer the direct single-card function for efficiency
      const _selectLiveCardModel = selectLiveCardModelFn || function (pl, id) {
        const all = selectAllLiveCardModels(pl);
        return Array.isArray(all) ? (all.find(function (n) { return n.id === id; }) || null) : null;
      };

      // Build initial reactive state
      stateRef.current = buildBoardState(payload, null, _selectLiveCardModel);

      const engine = LiveCard.init({
        resolve: function (id) { return stateRef.current && stateRef.current.modelsById[id]; },
        chartLib: (typeof Chart !== 'undefined') ? Chart : null,
        markdown: (typeof marked !== 'undefined') ? function (text) { return marked.parse(text); } : null,
        sanitize: (typeof DOMPurify !== 'undefined') ? function (html) { return DOMPurify.sanitize(html); } : null,
        onPatchState: async function (id, patch) {
          await fetchServer(paths.patchCard(id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch || {}),
          });
        },
        onRefresh: async function (id) {
          await fetchServer(paths.patchCard(id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
        },
        onAction: async function (id, actionType, actionPayload) {
          const uploadedPayload = await uploadActionFiles(boardId, id, actionType, actionPayload);
          await fetchServer(paths.cardAction(id), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actionType, payload: uploadedPayload || {} }),
          });
        },
        getChatMessages: async function (id) {
          const res = await fetchServer(paths.cardChats(id));
          if (!res.ok) return [];
          const chatPayload = await res.json();
          const items = Array.isArray(chatPayload && chatPayload.messages) ? chatPayload.messages : [];
          return items.map(function (m) {
            return {
              role: m && typeof m.role === 'string' ? m.role : 'system',
              text: m && typeof m.text === 'string' ? m.text : '',
              files: [],
            };
          });
        },
      });

      rootEl.innerHTML = '';
      board = LiveCard.Board(engine, rootEl, {
        initialState: stateRef.current,
        getNodeIds: function (s) { return s.cardIds; },
        selectNode: function (s, id) { return s.modelsById[id]; },
        mode: mode,
        canvas: canvas,
      });
      currentMode = mode;

      const origin = getServerOrigin();
      if (!origin) throw new Error('Server origin not resolved before SSE start');

      sse = new EventSource(`${origin}${paths.stream}`);
      sse.onmessage = function (evt) {
        try {
          const update = JSON.parse(evt.data || '{}');

          if (update && update.kind === 'notification-batch' && Array.isArray(update.notifications)) {
            // Incremental update — apply notifications to reactive state
            if (board) {
              board.setState(function (prev) {
                const next = applyNotification(prev, update.notifications, _selectLiveCardModel, getFullPayload);
                stateRef.current = next;
                return next;
              });
            }
          } else if (update && update.cardDefinitions) {
            // Full payload (initial SSE connect / reconnect) — rebuild state
            const next = buildBoardState(update, stateRef.current, _selectLiveCardModel);
            stateRef.current = next;
            if (board) board.setState(function () { return next; });
          }

          if (board && board.engine && typeof board.engine.onServerSseEvent === 'function') {
            board.engine.onServerSseEvent();
          } else if (board && board.engine && typeof board.engine.refreshOpenChatModal === 'function') {
            board.engine.refreshOpenChatModal();
          }
        } catch (err) {
          console.warn('Bad SSE payload', err);
        }
      };

      return board;
    }

    function dispose() {
      if (sse) {
        sse.close();
        sse = null;
      }
      board = null;
      stateRef.current = null;
    }

    function setMode(mode) {
      currentMode = String(mode || 'board');
      if (board && board.core && typeof board.core.setMode === 'function') {
        board.core.setMode(currentMode);
      }
    }

    function autoLayout() {
      if (!board) return;
      currentMode = 'canvas';
      if (board.core && typeof board.core.setMode === 'function') {
        board.core.setMode('canvas');
      }
      if (board.core && typeof board.core.autoLayout === 'function') {
        board.core.autoLayout();
      }
    }

    function setDevMode(enabled) {
      if (board && board.core && typeof board.core.setDevMode === 'function') {
        board.core.setDevMode(Boolean(enabled));
      }
    }

    function getCurrentMode() {
      return currentMode;
    }

    return {
      bootstrapBoard,
      dispose,
      setMode,
      autoLayout,
      setDevMode,
      getCurrentMode,
    };
  }

  window.ReusableBoardRuntimeClient = {
    createBoardRuntimeClient,
  };
})();
