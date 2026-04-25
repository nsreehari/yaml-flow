(function () {
  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function replaceNodeInPlace(target, source) {
    Object.keys(target).forEach((k) => delete target[k]);
    Object.assign(target, clone(source));
  }

  function stableNodeString(node) {
    return JSON.stringify(node);
  }

  function createBoardRuntimeClient(options) {
    if (!options || typeof options !== 'object') {
      throw new Error('options are required');
    }

    const fetchServer = options.fetchServer;
    const boardPaths = options.boardPaths;
    const buildLiveCardModelsFromArtifacts = options.buildLiveCardModelsFromArtifacts
      || (typeof window !== 'undefined' && window.BoardLiveGraph && window.BoardLiveGraph.buildLiveCardModelsFromArtifacts);
    const getServerOrigin = options.getServerOrigin;

    if (typeof fetchServer !== 'function') throw new Error('options.fetchServer is required');
    if (typeof boardPaths !== 'function') throw new Error('options.boardPaths is required');
    if (typeof buildLiveCardModelsFromArtifacts !== 'function') {
      throw new Error('options.buildLiveCardModelsFromArtifacts is required (or load board-livegraph-engine.js first)');
    }
    if (typeof getServerOrigin !== 'function') throw new Error('options.getServerOrigin is required');

    let nodesById = {};
    let board = null;
    let sse = null;
    let currentMode = String(options.initialMode || 'board');
    const canvas = options.canvas && typeof options.canvas === 'object'
      ? options.canvas
      : { height: '72vh', overflow: 'auto' };

    function syncBoardNodes(nextNodes) {
      const existingIds = new Set(board ? board.nodes.map((n) => n.id) : []);
      const nextById = Object.fromEntries(nextNodes.map((n) => [n.id, n]));
      let changed = false;

      if (board) {
        for (const id of existingIds) {
          if (!nextById[id] && !(nodesById[id] && nodesById[id].card && nodesById[id].card.virtual)) {
            board.remove(id);
            changed = true;
          }
        }
      }

      for (const nextNode of nextNodes) {
        const isVirtual = !!(nextNode.card && nextNode.card.virtual);
        const existing = nodesById[nextNode.id];
        if (existing) {
          const prevStr = stableNodeString(existing);
          const nextStr = stableNodeString(nextNode);
          if (prevStr !== nextStr) {
            replaceNodeInPlace(existing, nextNode);
            // Virtual nodes live in nodesById (for cfg.resolve) but never on the board canvas.
            if (!isVirtual) changed = true;
          }
        } else {
          nodesById[nextNode.id] = clone(nextNode);
          if (board && !isVirtual) { board.add(nodesById[nextNode.id]); changed = true; }
        }
      }

      if (board && changed) board.refresh();
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
      const runDemoSetup = p.runDemoSetup !== false;
      const mode = String(p.mode || currentMode || 'board');
      const rootEl = p.rootElement;
      if (!rootEl) throw new Error('bootstrapBoard requires params.rootElement');

      const paths = boardPaths(boardId);

      const boardPanelOpts = options.boardPanel || false;

      if (runDemoSetup) {
        const setup = await fetchServer(paths.demoSetup);
        if (!setup.ok) throw new Error(`Server demo-setup failed (${setup.status}).`);
      }

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
      const cards = buildLiveCardModelsFromArtifacts(payload);
      if (!Array.isArray(cards)) throw new Error('Server payload missing published runtime artifacts');

      nodesById = {};
      for (const n of cards) nodesById[n.id] = clone(n);

      const engine = LiveCard.init({
        resolve: (id) => nodesById[id],
        markdown: (typeof marked !== 'undefined')
          ? (text) => marked.parse(text)
          : null,
        onPatchState: async (id, patch) => {
          await fetchServer(paths.patchCard(id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch || {}),
          });
        },
        onRefresh: async (id) => {
          await fetchServer(paths.patchCard(id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
        },
        onAction: async (id, actionType, actionPayload) => {
          const uploadedPayload = await uploadActionFiles(boardId, id, actionType, actionPayload);
          await fetchServer(paths.cardAction(id), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actionType, payload: uploadedPayload || {} }),
          });
        },
        getChatMessages: async (id) => {
          const res = await fetchServer(paths.cardChats(id));
          if (!res.ok) return [];
          const chatPayload = await res.json();
          const items = Array.isArray(chatPayload && chatPayload.messages) ? chatPayload.messages : [];
          return items.map((m) => ({
            role: m && typeof m.role === 'string' ? m.role : 'system',
            text: m && typeof m.text === 'string' ? m.text : '',
            files: [],
          }));
        },
      });

      rootEl.innerHTML = '';
      board = LiveCard.Board(engine, rootEl, {
        nodes: Object.values(nodesById),
        mode,
        canvas,
        boardPanel: boardPanelOpts,
      });
      currentMode = mode;

      const origin = getServerOrigin();
      if (!origin) {
        throw new Error('Server origin not resolved before SSE start');
      }
      sse = new EventSource(`${origin}${paths.stream}`);
      sse.onmessage = function (evt) {
        try {
          const update = JSON.parse(evt.data || '{}');
          syncBoardNodes(buildLiveCardModelsFromArtifacts(update));
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
      nodesById = {};
    }

    function setMode(mode) {
      currentMode = String(mode || 'board');
      if (board) board.setMode(currentMode);
    }

    function autoLayout() {
      if (!board) return;
      board.setMode('canvas');
      currentMode = 'canvas';
      board.autoLayout();
    }

    function setDevMode(enabled) {
      if (board) board.setDevMode(Boolean(enabled));
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
