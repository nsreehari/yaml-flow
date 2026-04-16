// ingest-board.js — Ingest Board: a LiveCard Board type for batch ingest UIs
//
// Pure component. Zero I/O (no fetch, no EventSource, no polling).
// All side-effects delegated to host via callbacks.
//
// API:
//   const ib = IngestBoard.create(containerEl, opts)
//
//   ib.setBatches(batches)               — rebuild board from batch array
//   ib.getChat(boardId)                  — get chat element API for a card
//   ib.getFileUpload(boardId)            — get file-upload element API for a card
//   ib.getActions(boardId)               — get actions element API for a card
//   ib.showChatModal(boardId, messages)  — open Bootstrap modal with chat history
//   ib.destroy()
//
// Required opts:
//   onSend(boardId, { text, files })     — host handles: upload files + message → call getChat().appendMessage() with results
//   onConfirm(boardId)                   — host handles: POST confirm → SSE → update board
//   onDiscard(boardId)                   — host handles: POST discard → call ib.setBatches()
//
// Optional opts:
//   onViewChat(boardId)                  — host handles: fetch chat → call ib.showChatModal()
//   onRefresh()                          — host handles: fetch batches → call ib.setBatches()
//   compact         — smaller card columns (default: false)
//   engine          — existing LiveCard engine (one is created if omitted)
//   markdown        — markdown renderer fn
//   sanitize        — HTML sanitizer fn

// eslint-disable-next-line no-unused-vars
var IngestBoard = (function () {
  'use strict';

  function create(containerEl, opts) {
    opts = opts || {};
    if (!opts.onSend)    throw new Error('IngestBoard: opts.onSend is required');
    if (!opts.onConfirm) throw new Error('IngestBoard: opts.onConfirm is required');
    if (!opts.onDiscard) throw new Error('IngestBoard: opts.onDiscard is required');

    const compact     = opts.compact || false;
    const onSend      = opts.onSend;
    const onConfirm   = opts.onConfirm;
    const onDiscard   = opts.onDiscard;
    const onViewChat  = opts.onViewChat || null;
    const onRefresh   = opts.onRefresh || null;
    const mdFn        = opts.markdown || (typeof marked   !== 'undefined' ? function (t) { return marked.parse(t); } : null);
    const sanFn       = opts.sanitize || (typeof DOMPurify !== 'undefined' ? function (h) { return DOMPurify.sanitize(h); } : null);

    let board = null;
    const nodes = {};  // id → node

    // ---- Engine ----

    const engine = opts.engine || LiveCard.init({
      resolve:      function (id) { return nodes[id]; },
      onPatch:      function () {},
      onPatchState: function () {},
      onRefresh:    onRefresh || function () {},
      onAction:     handleAction,
      markdown:     mdFn,
      sanitize:     sanFn,
    });

    // ---- Action dispatcher (pure — delegates to host callbacks) ----

    function handleAction(nodeId, actionType, payload) {
      if (actionType === 'chat-send') {
        // For the "new" card, boardId is null until host creates one
        var boardId = nodeId === '__new__' ? null : nodeId;
        onSend(boardId, { text: payload.text, files: payload.files });
      } else if (actionType === 'action') {
        if (payload.buttonId === 'confirm') onConfirm(nodeId);
        else if (payload.buttonId === 'discard') onDiscard(nodeId);
        else if (payload.buttonId === 'view-chat' && onViewChat) onViewChat(nodeId);
      }
    }

    // ---- Node builders ----

    function buildActiveNode(batch) {
      return {
        id: batch.id,
        type: 'card',
        meta: { title: batch.id, tags: [batch.status === 'open-items' ? 'open-items' : 'ready'] },
        state: {
          status: batch.processing ? 'loading' : 'fresh',
          messages: batch.chat || [],
          files: batch.files || [],
          batchStatus: batch.status,
        },
        view: {
          elements: [
            {
              id: 'chat',
              kind: 'chat',
              data: { bind: 'state.messages', fileAttach: true, placeholder: 'Add files or type a message...' }
            },
            {
              id: 'actions',
              kind: 'actions',
              data: {
                buttons: [
                  { id: 'confirm', label: 'Confirm & Merge', style: 'success', disabled: batch.status !== 'ready' || !!batch.processing },
                  { id: 'discard', label: 'Discard', style: 'outline-danger' }
                ]
              }
            }
          ],
          layout: { board: { col: compact ? 6 : 8, order: 0 } },
          features: { refresh: false }
        }
      };
    }

    function buildCompletedNode(batch, order) {
      var elements = [];

      if (batch.files && batch.files.length) {
        elements.push({
          id: 'files',
          kind: 'file-upload',
          data: { bind: 'state.files', upload: false }
        });
      }

      if (batch.summary) {
        elements.push({
          id: 'summary',
          kind: 'text',
          data: { bind: 'state.summary', style: 'muted' }
        });
      }

      if (batch.chatCount > 0 && onViewChat) {
        elements.push({
          id: 'card-actions',
          kind: 'actions',
          data: { buttons: [{ id: 'view-chat', label: '\uD83D\uDCAC ' + batch.chatCount + ' message(s)', style: 'outline-secondary' }] }
        });
      }

      return {
        id: batch.id,
        type: 'card',
        meta: { title: batch.id, tags: ['confirmed'] },
        state: {
          status: 'fresh',
          files: batch.files || [],
          summary: batch.summary || '',
        },
        view: {
          elements: elements,
          layout: { board: { col: compact ? 6 : 4, order: order } },
          features: { refresh: false }
        }
      };
    }

    function buildNewNode() {
      return {
        id: '__new__',
        type: 'card',
        meta: { title: 'New Batch', tags: ['new'] },
        state: { status: 'fresh', messages: [] },
        view: {
          elements: [
            {
              id: 'chat',
              kind: 'chat',
              data: { bind: 'state.messages', fileAttach: true, placeholder: 'Add files or type a message...' }
            }
          ],
          layout: { board: { col: compact ? 6 : 8, order: -1 } },
          features: { refresh: false }
        }
      };
    }

    // ---- setBatches — rebuild the board from data ----

    function setBatches(batches) {
      Object.keys(nodes).forEach(function (k) { delete nodes[k]; });

      var hasActive = batches.some(function (b) { return b.status === 'ready' || b.status === 'open-items'; });
      var allNodes = [];

      if (!hasActive) {
        var nn = buildNewNode();
        nodes.__new__ = nn;
        allNodes.push(nn);
      }

      var order = 1;
      batches.forEach(function (b) {
        var isActive = b.status === 'ready' || b.status === 'open-items';
        var n = isActive ? buildActiveNode(b) : buildCompletedNode(b, order++);
        nodes[b.id] = n;
        allNodes.push(n);
      });

      if (board) board.destroy();
      board = LiveCard.Board(engine, containerEl, {
        nodes: allNodes,
        mode: 'board',
        showNotes: false,
        showChat: false,
      });
    }

    // ---- Element accessors (host uses these to push data in) ----

    function getChat(boardId) {
      var el = engine.getElement(boardId, 'chat');
      return el && el._chat || null;
    }

    function getFileUpload(boardId) {
      var el = engine.getElement(boardId, 'files');
      return el && el._fileUpload || null;
    }

    function getActions(boardId) {
      var el = engine.getElement(boardId, 'actions') || engine.getElement(boardId, 'card-actions');
      return el && el._actions || null;
    }

    // ---- Chat modal (pure — caller passes messages) ----

    function showChatModal(boardId, messages) {
      var existing = document.getElementById('lc-chat-modal');
      if (existing) existing.remove();
      var bd = document.querySelector('.modal-backdrop');
      if (bd) bd.remove();

      var _e = function (t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

      var wrap = document.createElement('div');
      wrap.innerHTML =
        '<div class="modal fade" id="lc-chat-modal" tabindex="-1">' +
          '<div class="modal-dialog modal-dialog-scrollable">' +
            '<div class="modal-content">' +
              '<div class="modal-header">' +
                '<h6 class="modal-title">' + _e(boardId) + '</h6>' +
                '<button type="button" class="btn-close" data-bs-dismiss="modal"></button>' +
              '</div>' +
              '<div class="modal-body"><div class="lc-chat-body" id="lc-chat-modal-body" style="max-height:none"></div></div>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap.firstElementChild);

      var bodyEl = document.getElementById('lc-chat-modal-body');
      messages.forEach(function (msg) {
        var bub = document.createElement('div');
        var rc = msg.role === 'user' ? 'lc-chat-bubble-user'
          : msg.role === 'assistant' ? 'lc-chat-bubble-assistant'
          : 'lc-chat-bubble-system';
        bub.className = 'lc-chat-bubble ' + rc;
        if (msg.role === 'assistant' && mdFn) {
          var html = mdFn(msg.text);
          if (sanFn) html = sanFn(html);
          bub.innerHTML = html;
        } else {
          bub.textContent = msg.text;
        }
        bodyEl.appendChild(bub);
      });

      var modal = new bootstrap.Modal(document.getElementById('lc-chat-modal'));
      modal.show();
      document.getElementById('lc-chat-modal').addEventListener('hidden.bs.modal', function () {
        document.getElementById('lc-chat-modal').remove();
      });
    }

    // ---- Lifecycle ----

    function destroy() {
      if (board) board.destroy();
      board = null;
      Object.keys(nodes).forEach(function (k) { delete nodes[k]; });
    }

    return {
      setBatches:    setBatches,
      getChat:       getChat,
      getFileUpload: getFileUpload,
      getActions:    getActions,
      showChatModal: showChatModal,
      destroy:       destroy,
      get engine()   { return engine; },
      get board()    { return board; },
    };
  }

  return { create: create };
})();
