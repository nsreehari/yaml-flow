// live-cards.js — LiveCards v3: Node-based Board/Canvas engine
//
// Schema: Each node has { id } required; all else optional.
//   id, meta, card_data, requires, provides, sources, compute, view
//   Nodes with view render as cards; nodes with sources but no view render as source pills in canvas.
//   compute[] — ordered array of { bindTo, expr } JSONata steps → writes to node.computed_values (ephemeral)
//   sources[] — open objects: only bindTo + outputFile matter to the engine; all other fields are
//               passed verbatim to the board's task-executor (--in JSON). Users define their own
//               shape (kind, url, mailbox, channel, model, ...) per executor.
//   requires[] — upstream node IDs; engine subscribes automatically
//   provides[] — [{ bindTo, src }] explicit downstream token bindings
//
// Uses Bootstrap 5 for layout/forms, optional Chart.js for charts.
// Uses CardCompute (card-compute.js) for declarative compute expressions.
//
// API:
//   const engine = LiveCard.init({ resolve, onPatch, onPatchState, onRefresh, onAction, getChatMessages, markdown, sanitize, chartLib });
//   engine.render(node, el, opts?)     — render a card node into a DOM element
//   engine.update(nodeId, patch)       — in-place update (status, re-render)
//   engine.destroy(nodeId)             — tear down one node
//   engine.destroyAll()                — tear down all
//   engine.notify(nodeId, data?)       — signal change → downstream recompute
//   engine.subscribe(nodeId, cb)       — listen for changes; returns unsub fn
//   engine.appendChatMessage(nodeId, role, text)
//   engine.registerRenderer(name, fn)
//
//   const board = LiveCard.Board(engine, el, { nodes, positions?, mode, canvas })
//   board.setMode('board'|'canvas'), board.autoLayout(), board.add(node), board.remove(id)

// eslint-disable-next-line no-unused-vars
var LiveCard = (function () {
  'use strict';

  // ===========================================================================
  // CSS injection (once)
  // ===========================================================================

  let _cssInjected = false;
  function _injectCSS() {
    if (_cssInjected) return;
    _cssInjected = true;
    const s = document.createElement('style');
    s.textContent = `
      .lc-card { position:relative; }
      .lc-status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; flex-shrink:0; }
      .lc-metric-value { font-size:2rem; font-weight:700; line-height:1.2; }
      .lc-chart-wrap { position:relative; min-height:200px; max-height:400px; }
      .lc-chat-messages { max-height:200px; overflow-y:auto; }
      .lc-chat-msg { padding:0.25rem 0.5rem; margin:0.25rem 0; border-radius:0.5rem; max-width:85%; }
      .lc-chat-user { background:var(--bs-primary-bg-subtle,#cfe2ff); margin-left:auto; }
      .lc-chat-assistant { background:var(--bs-light,#f8f9fa); }
      .lc-alert-dot { display:inline-block; width:14px; height:14px; border-radius:50%; flex-shrink:0; }
      .lc-alert-green { background:var(--bs-success,#198754); }
      .lc-alert-amber { background:var(--bs-warning,#ffc107); }
      .lc-alert-red { background:var(--bs-danger,#dc3545); }
      .lc-todo-item { display:flex; align-items:center; gap:0.5rem; min-height:44px; padding:0.25rem 0; border-bottom:1px solid var(--bs-border-color-translucent,#dee2e6); }
      .lc-todo-item:last-child { border-bottom:none; }
      .lc-notes-preview { min-height:80px; }
      .lc-source-pill { display:inline-flex; align-items:center; gap:0.5rem; padding:0.5rem 0.75rem; border-radius:2rem; font-size:0.8rem; background:var(--bs-light,#f8f9fa); border:1px solid var(--bs-border-color,#dee2e6); }
      .lc-dropzone { border:2px dashed var(--bs-border-color,#dee2e6); border-radius:.5rem; padding:1.5rem; text-align:center; cursor:pointer; transition:border-color .15s,background .15s; }
      .lc-dropzone:hover { border-color:var(--bs-primary,#0d6efd); }
      .lc-dropzone.lc-drag-over { border-color:var(--bs-primary,#0d6efd); background:rgba(13,110,253,.05); }
      .lc-dropzone.lc-disabled { pointer-events:none; opacity:.5; }
      .lc-staged-file { display:flex; align-items:center; gap:.5rem; padding:.125rem 0; }
      .lc-chat-el { display:flex; flex-direction:column; }
      .lc-chat-body { flex:1; overflow-y:auto; max-height:300px; padding:.25rem; }
      .lc-chat-bubble { padding:.5rem .75rem; margin:.375rem 0; border-radius:.75rem; max-width:85%; word-wrap:break-word; font-size:.875rem; line-height:1.4; }
      .lc-chat-bubble-user { background:var(--bs-primary-bg-subtle,#cfe2ff); margin-left:auto; }
      .lc-chat-bubble-assistant { background:var(--bs-light,#f8f9fa); }
      .lc-chat-bubble-system { background:transparent; color:var(--bs-secondary,#6c757d); font-style:italic; text-align:center; max-width:100%; font-size:.8rem; }
      .lc-chat-bubble-pending { opacity:.85; }
      .lc-chat-bubble-pending .spinner-border { width:.75rem; height:.75rem; margin-left:.4rem; border-width:.12em; vertical-align:middle; }
      .lc-chat-input-bar { display:flex; gap:.25rem; align-items:center; }
      .lc-chat-modal-input-row { display:flex; align-items:center; gap:.375rem; }
      .lc-chat-modal-input-row .form-control { min-width:0; }
      .lc-chat-modal-input-row textarea.form-control { resize:none; overflow-y:hidden; min-height:38px; max-height:120px; }
      .lc-chat-processing { display:flex; align-items:center; gap:.5rem; padding:.25rem .5rem; color:var(--bs-secondary,#6c757d); font-size:.8rem; }
      .lc-chat-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:12000; display:none; align-items:center; justify-content:center; padding:1rem; }
      .lc-chat-modal-backdrop.lc-open { display:flex; }
      .lc-chat-modal-backdrop .modal-dialog { max-height:90vh; }
      .lc-chat-modal-backdrop .modal-content { display:flex; flex-direction:column; max-height:90vh; }
      .lc-chat-modal-backdrop .modal-body { overflow-y:auto; flex:1; min-height:200px; padding:1rem; }
      .lc-files-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:11950; display:none; align-items:center; justify-content:center; padding:1rem; }
      .lc-files-modal-backdrop.lc-open { display:flex; }
      .lc-files-modal-backdrop .modal-dialog { max-height:90vh; }
      .lc-files-modal-backdrop .modal-content { display:flex; flex-direction:column; max-height:90vh; }
      .lc-files-modal-backdrop .modal-body { overflow-y:auto; flex:1; min-height:200px; padding:1rem; }
      @media (max-width:576px) {
        .lc-metric-value { font-size:1.5rem; }
        .lc-chart-wrap { min-height:150px; }
        .lc-chat-msg { max-width:95%; }
        .lc-chat-body { max-height:200px; }
        .lc-chat-bubble { max-width:95%; }
      }
    `;
    document.head.appendChild(s);
  }

  // ===========================================================================
  // Global utilities
  // ===========================================================================

  const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function _esc(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, ch => _escMap[ch]);
  }

  function _pathParts(path) {
    if (!path || typeof path !== 'string') return [];
    // Support both dot notation (a.b.c) and bracket notation (a.b[0].c).
    return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  }

  function _deepGet(obj, path) {
    if (!path || !obj) return undefined;
    const parts = _pathParts(path);
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function _deepSet(obj, path, value) {
    const parts = _pathParts(path);
    if (!parts.length) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function _statusDot(status) {
    const colors = { fresh: 'var(--bs-success)', stale: 'var(--bs-warning)', error: 'var(--bs-danger)', loading: 'var(--bs-info)' };
    return `<span class="lc-status-dot" style="background:${colors[status] || 'var(--bs-secondary)'}" title="${_esc(status || 'unknown')}"></span>`;
  }

  function _timeAgo(iso) {
    if (!iso) return '';
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (isNaN(d) || d < 0) return '';
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  function _parseThreshold(expr) {
    const m = String(expr).match(/^(<=?|>=?|===?)\s*(.+)$/);
    return m ? { op: m[1], value: parseFloat(m[2]) } : null;
  }

  function _evalThreshold(value, expr) {
    const t = _parseThreshold(expr);
    if (!t || isNaN(t.value)) return false;
    switch (t.op) {
      case '<':  return value < t.value;
      case '<=': return value <= t.value;
      case '>':  return value > t.value;
      case '>=': return value >= t.value;
      case '=': case '==': case '===': return value === t.value;
    }
    return false;
  }

  function _detectChartType(data) {
    if (!data.length) return 'bar';
    const s = data[0];
    if (s.label !== undefined && s.value !== undefined && !s.x && !s.date) return 'pie';
    if (s.x !== undefined || s.date !== undefined) return 'line';
    return 'bar';
  }

  const _chartColors = ['#0d6efd','#198754','#ffc107','#dc3545','#6f42c1','#0dcaf0','#fd7e14','#20c997','#d63384','#6c757d'];

  // ===========================================================================
  // init — creates isolated engine instance
  // ===========================================================================

  function init(config) {
    _injectCSS();

    const cfg = {
      resolve:      config.resolve,
      onPatch:      config.onPatch      || function () {},
      onPatchState: config.onPatchState || function () {},
      onRefresh:    config.onRefresh    || null,
      onChat:       config.onChat       || null,
      markdown:     config.markdown     || null,
      sanitize:     config.sanitize     || null,
      chartLib:     config.chartLib     || null,
      onAction:     config.onAction     || function () {},
      getChatMessages: config.getChatMessages || null,
    };

    const _cleanup = {};    // nodeId → { ac, timers, charts, unsubs }
    const _subs = {};       // nodeId → Set<callback>
    const _etState = {};    // stateKey → { currentState, pending } for editable-table dirty tracking
    const _formState = {};  // stateKey → { currentState, pending } for form dirty tracking
    const _notesState = {}; // stateKey → { currentState, pending } for notes dirty tracking
    const _todoState = {};  // stateKey → { currentState, pending } for todo dirty tracking
    const _renderers = {}; // kind → fn
    const _nodeEls = {};   // nodeId → { container, resultEl, uid }
    const _chatModal = {
      backdrop: null,
      title: null,
      body: null,
      input: null,
      fileInput: null,
      staged: null,
      sendBtn: null,
      attachBtn: null,
      closeBtn: null,
      currentNodeId: null,
      stagedFiles: [],
      loading: false,
    };
    const _filesModal = {
      backdrop: null,
      title: null,
      body: null,
      staged: null,
      fileInput: null,
      dropzone: null,
      uploadBtn: null,
      attachBtn: null,
      closeBtn: null,
      currentNodeId: null,
      stagedFiles: [],
      pollingTimer: null,
      loading: false,
    };

    // ---- Helpers ----

    function _renderMd(text) {
      if (!text) return '';
      const html = cfg.markdown ? cfg.markdown(text) : _esc(text);
      return cfg.sanitize ? cfg.sanitize(html) : html;
    }

    function _getCleanup(id) {
      if (!_cleanup[id]) _cleanup[id] = { ac: new AbortController(), timers: [], charts: [], unsubs: [] };
      return _cleanup[id];
    }

    function _runCompute() {
      // Runtime payload is authoritative; UI never recomputes derived values.
      return Promise.resolve();
    }

    function _ensureChatModal() {
      if (_chatModal.backdrop) return;

      const backdrop = document.createElement('div');
      backdrop.className = 'lc-chat-modal-backdrop';
      backdrop.innerHTML = '' +
        '<div class="modal-dialog modal-lg modal-dialog-centered" role="dialog" aria-modal="true" aria-label="Card chat">' +
        '  <div class="modal-content bg-white">' +
        '    <div class="modal-header border-bottom p-3 d-flex align-items-center justify-content-between">' +
        '      <h5 class="modal-title lc-chat-modal-title">Chat</h5>' +
        '      <button type="button" class="btn btn-sm btn-outline-secondary" data-lc-chat-close aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
        '    </div>' +
        '    <div class="modal-body bg-light" data-lc-chat-body></div>' +
        '    <div class="modal-footer flex-column align-items-stretch border-top p-3 gap-3">' +
        '      <div data-lc-chat-staged class="small w-100"></div>' +
        '      <input type="file" class="d-none" data-lc-chat-file multiple>' +
        '      <div class="lc-chat-modal-input-row mt-2">' +
        '        <button type="button" class="btn btn-sm btn-outline-secondary" data-lc-chat-attach title="Attach files" aria-label="Attach files">' +
        '          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>' +
        '        </button>' +
        '        <textarea class="form-control" data-lc-chat-input rows="1" placeholder="Type a message..."></textarea>' +
        '        <button type="button" class="btn btn-sm btn-primary" data-lc-chat-send aria-label="Send">' +
        '          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
        '        </button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

      document.body.appendChild(backdrop);
      _chatModal.backdrop = backdrop;
      _chatModal.title = backdrop.querySelector('.lc-chat-modal-title');
      _chatModal.body = backdrop.querySelector('[data-lc-chat-body]');
      _chatModal.input = backdrop.querySelector('[data-lc-chat-input]');
      _chatModal.fileInput = backdrop.querySelector('[data-lc-chat-file]');
      _chatModal.staged = backdrop.querySelector('[data-lc-chat-staged]');
      _chatModal.sendBtn = backdrop.querySelector('[data-lc-chat-send]');
      _chatModal.attachBtn = backdrop.querySelector('[data-lc-chat-attach]');
      _chatModal.closeBtn = backdrop.querySelector('[data-lc-chat-close]');

      function resizeChatInput() {
        if (!_chatModal.input) return;
        _chatModal.input.style.height = 'auto';
        _chatModal.input.style.height = Math.min(_chatModal.input.scrollHeight, 120) + 'px';
      }

      const close = function () {
        _chatModal.currentNodeId = null;
        _chatModal.stagedFiles = [];
        _chatModal.staged.innerHTML = '';
        _chatModal.input.value = '';
        resizeChatInput();
        _chatModal.backdrop.classList.remove('lc-open');
      };

      function renderStagedFiles() {
        if (!_chatModal.stagedFiles.length) {
          _chatModal.staged.innerHTML = '';
          return;
        }
        _chatModal.staged.innerHTML = _chatModal.stagedFiles.map(function (f, i) {
          return '<span class="badge text-bg-light border me-1 mb-1">' + _esc(f.name || 'file') +
            ' <button type="button" class="btn btn-sm btn-link text-danger p-0 ms-1" data-lc-rm-file="' + i + '">&times;</button></span>';
        }).join('');
        _chatModal.staged.querySelectorAll('[data-lc-rm-file]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            const idx = parseInt(btn.getAttribute('data-lc-rm-file') || '-1', 10);
            if (idx >= 0) _chatModal.stagedFiles.splice(idx, 1);
            renderStagedFiles();
          });
        });
      }

      async function sendMessage() {
        if (_chatModal.loading || !_chatModal.currentNodeId) return;
        const nodeId = _chatModal.currentNodeId;
        const text = (_chatModal.input.value || '').trim();
        const files = _chatModal.stagedFiles.slice();
        if (!text && !files.length) return;

        _chatModal.loading = true;
        _chatModal.sendBtn.disabled = true;
        _chatModal.attachBtn.disabled = true;

        _appendPendingModalChatMessage(text);

        _chatModal.input.value = '';
        _chatModal.stagedFiles = [];
        resizeChatInput();
        renderStagedFiles();

        try {
          await Promise.resolve(cfg.onAction(nodeId, 'chat-send', { text, files }));
        } catch (err) {
          _clearPendingModalChatMessages();
          _appendModalChatMessage('system', 'Failed to send message: ' + String((err && err.message) || err), []);
        } finally {
          _chatModal.loading = false;
          _chatModal.sendBtn.disabled = false;
          _chatModal.attachBtn.disabled = false;
        }
      }

      _chatModal.closeBtn.addEventListener('click', close);
      backdrop.addEventListener('click', function (evt) {
        if (evt.target === backdrop) close();
      });
      _chatModal.attachBtn.addEventListener('click', function () {
        _chatModal.fileInput.click();
      });
      _chatModal.fileInput.addEventListener('change', function (evt) {
        const files = evt.target && evt.target.files ? Array.from(evt.target.files) : [];
        for (const f of files) {
          if (!_chatModal.stagedFiles.find(function (x) { return x.name === f.name && x.size === f.size && x.lastModified === f.lastModified; })) {
            _chatModal.stagedFiles.push(f);
          }
        }
        evt.target.value = '';
        renderStagedFiles();
      });
      _chatModal.sendBtn.addEventListener('click', sendMessage);
      _chatModal.input.addEventListener('input', resizeChatInput);
      _chatModal.input.addEventListener('keydown', function (evt) {
        if (evt.key === 'Enter' && !evt.shiftKey) {
          evt.preventDefault();
          sendMessage();
        }
      });
      resizeChatInput();
      document.addEventListener('keydown', function (evt) {
        if (evt.key === 'Escape' && _chatModal.backdrop && _chatModal.backdrop.classList.contains('lc-open')) close();
      });
    }

    function _normalizeChatMessages(rawMessages) {
      const list = Array.isArray(rawMessages) ? rawMessages : [];
      return list.map(function (msg) {
        if (!msg || typeof msg !== 'object') return null;
        const role = typeof msg.role === 'string' ? msg.role : 'system';
        const text = typeof msg.text === 'string'
          ? msg.text
          : (typeof msg.message === 'string' ? msg.message : '');
        const files = Array.isArray(msg.files) ? msg.files : [];
        return { role: role.toLowerCase(), text, files };
      }).filter(Boolean);
    }

    function _appendModalChatMessage(role, text, files) {
      _ensureChatModal();
      if (!_chatModal.body) return;

      const bubble = document.createElement('div');
      const normalizedRole = role === 'user' || role === 'assistant' ? role : 'system';
      const roleClass = normalizedRole === 'user'
        ? 'lc-chat-bubble-user'
        : (normalizedRole === 'assistant' ? 'lc-chat-bubble-assistant' : 'lc-chat-bubble-system');
      bubble.className = 'lc-chat-bubble ' + roleClass;
      bubble.textContent = text || '';

      if (Array.isArray(files) && files.length) {
        const meta = document.createElement('div');
        meta.className = 'lc-chat-inline-meta';
        meta.textContent = files.map(function (f) {
          if (!f) return 'file';
          return typeof f === 'string' ? f : (f.name || 'file');
        }).join(', ');
        bubble.appendChild(meta);
      }

      _chatModal.body.appendChild(bubble);
      _chatModal.body.scrollTop = _chatModal.body.scrollHeight;
    }

    function _appendPendingModalChatMessage(text) {
      _ensureChatModal();
      if (!_chatModal.body) return;

      const bubble = document.createElement('div');
      bubble.className = 'lc-chat-bubble lc-chat-bubble-user lc-chat-bubble-pending';
      bubble.setAttribute('data-lc-chat-pending', '1');
      bubble.textContent = text || '';

      const spinner = document.createElement('span');
      spinner.className = 'spinner-border spinner-border-sm';
      spinner.setAttribute('role', 'status');
      spinner.setAttribute('aria-label', 'Sending');
      bubble.appendChild(spinner);

      _chatModal.body.appendChild(bubble);
      _chatModal.body.scrollTop = _chatModal.body.scrollHeight;
    }

    function _clearPendingModalChatMessages() {
      if (!_chatModal.body) return;
      _chatModal.body.querySelectorAll('[data-lc-chat-pending="1"]').forEach(function (el) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
    }

    async function _refreshModalChatHistory(nodeId) {
      if (_chatModal.currentNodeId !== nodeId) return;

      const node = cfg.resolve(nodeId);
      let messages = [];
      if (typeof cfg.getChatMessages === 'function') {
        try {
          messages = await Promise.resolve(cfg.getChatMessages(nodeId));
        } catch {
          messages = [];
        }
      } else if (node && node.card_data && Array.isArray(node.card_data.messages)) {
        messages = node.card_data.messages;
      }

      const normalized = _normalizeChatMessages(messages);
      _chatModal.body.innerHTML = '';
      if (!normalized.length) {
        _chatModal.body.innerHTML = '<div class="text-muted small">No messages yet.</div>';
        return;
      }
      normalized.forEach(function (m) { _appendModalChatMessage(m.role, m.text, m.files); });
    }

    async function openChatModal(nodeId) {
      _ensureChatModal();
      const node = cfg.resolve(nodeId);
      if (!node) return;
      const title = (node.card && node.card.meta && node.card.meta.title) || node.id;
      _chatModal.currentNodeId = nodeId;
      _chatModal.title.textContent = 'Chat: ' + title;
      _chatModal.body.innerHTML = '<div class="text-muted small">Loading...</div>';
      _chatModal.backdrop.classList.add('lc-open');

      // Disable input controls when card_data.features.chat.disabled is true
      const chatDisabled = !!(node.card_data && node.card_data.features && node.card_data.features.chat && node.card_data.features.chat.disabled);
      _chatModal.input.disabled = chatDisabled;
      _chatModal.attachBtn.disabled = chatDisabled;
      _chatModal.sendBtn.disabled = chatDisabled;
      _chatModal.input.placeholder = chatDisabled ? 'Chat is disabled for this card.' : 'Type a message...';

      if (!chatDisabled) _chatModal.input.focus();
      await _refreshModalChatHistory(nodeId);
    }

    function _ensureFilesModal() {
      if (_filesModal.backdrop) return;

      const backdrop = document.createElement('div');
      backdrop.className = 'lc-files-modal-backdrop';
      backdrop.innerHTML = '' +
        '<div class="modal-dialog modal-lg modal-dialog-centered" role="dialog" aria-modal="true" aria-label="Card files">' +
        '  <div class="modal-content bg-white">' +
        '    <div class="modal-header border-bottom p-3 d-flex align-items-center justify-content-between">' +
        '      <h5 class="modal-title lc-files-modal-title">Files</h5>' +
        '      <button type="button" class="btn btn-sm btn-outline-secondary" data-lc-files-close aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
        '    </div>' +
        '    <div class="modal-body bg-light" data-lc-files-body></div>' +
        '    <div class="modal-footer flex-column align-items-stretch border-top p-3 gap-3">' +
        '      <div class="lc-dropzone border-2 border-dashed p-4 text-center cursor-pointer rounded" data-lc-files-dz>' +
        '        <div class="small text-muted mb-2">Drop files here or click to browse</div>' +
        '        <input type="file" class="d-none" data-lc-files-input multiple>' +
        '      </div>' +
        '      <div data-lc-files-staged class="small w-100 d-flex flex-wrap gap-2"></div>' +
        '      <div class="d-flex justify-content-end gap-2 w-100">' +
        '        <button type="button" class="btn btn-sm btn-outline-secondary" data-lc-files-attach>Select files</button>' +
        '        <button type="button" class="btn btn-sm btn-primary" data-lc-files-upload>Upload</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

      document.body.appendChild(backdrop);
      _filesModal.backdrop = backdrop;
      _filesModal.title = backdrop.querySelector('.lc-files-modal-title');
      _filesModal.body = backdrop.querySelector('[data-lc-files-body]');
      _filesModal.staged = backdrop.querySelector('[data-lc-files-staged]');
      _filesModal.fileInput = backdrop.querySelector('[data-lc-files-input]');
      _filesModal.dropzone = backdrop.querySelector('[data-lc-files-dz]');
      _filesModal.uploadBtn = backdrop.querySelector('[data-lc-files-upload]');
      _filesModal.attachBtn = backdrop.querySelector('[data-lc-files-attach]');
      _filesModal.closeBtn = backdrop.querySelector('[data-lc-files-close]');

      const close = function () {
        _filesModal.currentNodeId = null;
        _filesModal.stagedFiles = [];
        _filesModal.staged.innerHTML = '';
        _filesModal.backdrop.classList.remove('lc-open');
        if (_filesModal.pollingTimer) {
          clearInterval(_filesModal.pollingTimer);
          _filesModal.pollingTimer = null;
        }
      };

      function renderStagedFiles() {
        if (!_filesModal.stagedFiles.length) {
          _filesModal.staged.innerHTML = '';
          return;
        }
        _filesModal.staged.innerHTML = _filesModal.stagedFiles.map(function (f, i) {
          return '<span class="badge text-bg-light border me-1 mb-1">' + _esc(f.name || 'file') +
            ' <button type="button" class="btn btn-sm btn-link text-danger p-0 ms-1" data-lc-files-rm="' + i + '">&times;</button></span>';
        }).join('');
        _filesModal.staged.querySelectorAll('[data-lc-files-rm]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            const idx = parseInt(btn.getAttribute('data-lc-files-rm') || '-1', 10);
            if (idx >= 0) _filesModal.stagedFiles.splice(idx, 1);
            renderStagedFiles();
          });
        });
      }

      function addFiles(fileList) {
        const files = Array.from(fileList || []);
        for (const f of files) {
          if (!_filesModal.stagedFiles.find(function (x) { return x.name === f.name && x.size === f.size && x.lastModified === f.lastModified; })) {
            _filesModal.stagedFiles.push(f);
          }
        }
        renderStagedFiles();
      }

      async function uploadFiles() {
        if (_filesModal.loading || !_filesModal.currentNodeId || !_filesModal.stagedFiles.length) return;
        const nodeId = _filesModal.currentNodeId;
        const files = _filesModal.stagedFiles.slice();
        _filesModal.loading = true;
        _filesModal.uploadBtn.disabled = true;
        _filesModal.attachBtn.disabled = true;
        _filesModal.dropzone.classList.add('lc-disabled');

        try {
          await Promise.resolve(cfg.onAction(nodeId, 'file-upload', { files }));
          _filesModal.stagedFiles = [];
          renderStagedFiles();
          _refreshFilesModalList(nodeId);
        } catch (err) {
          _filesModal.staged.innerHTML = '<span class="text-danger">Upload failed: ' + _esc(String((err && err.message) || err)) + '</span>';
        } finally {
          _filesModal.loading = false;
          _filesModal.uploadBtn.disabled = false;
          _filesModal.attachBtn.disabled = false;
          _filesModal.dropzone.classList.remove('lc-disabled');
        }
      }

      _filesModal.closeBtn.addEventListener('click', close);
      backdrop.addEventListener('click', function (evt) {
        if (evt.target === backdrop) close();
      });
      _filesModal.attachBtn.addEventListener('click', function () {
        _filesModal.fileInput.click();
      });
      _filesModal.fileInput.addEventListener('change', function (evt) {
        addFiles(evt.target && evt.target.files ? evt.target.files : []);
        evt.target.value = '';
      });
      _filesModal.uploadBtn.addEventListener('click', uploadFiles);
      _filesModal.dropzone.addEventListener('click', function () {
        if (!_filesModal.loading) _filesModal.fileInput.click();
      });
      _filesModal.dropzone.addEventListener('dragover', function (evt) {
        evt.preventDefault();
        _filesModal.dropzone.classList.add('lc-drag-over');
      });
      _filesModal.dropzone.addEventListener('dragleave', function () {
        _filesModal.dropzone.classList.remove('lc-drag-over');
      });
      _filesModal.dropzone.addEventListener('drop', function (evt) {
        evt.preventDefault();
        _filesModal.dropzone.classList.remove('lc-drag-over');
        addFiles(evt.dataTransfer && evt.dataTransfer.files ? evt.dataTransfer.files : []);
      });
      document.addEventListener('keydown', function (evt) {
        if (evt.key === 'Escape' && _filesModal.backdrop && _filesModal.backdrop.classList.contains('lc-open')) close();
      });
    }

    function _currentNodeFiles(nodeId) {
      const node = cfg.resolve(nodeId);
      const files = node && node.card_data && Array.isArray(node.card_data.files) ? node.card_data.files : [];
      return files.filter(Boolean);
    }

    function _refreshFilesModalList(nodeId) {
      if (_filesModal.currentNodeId !== nodeId) return;
      const files = _currentNodeFiles(nodeId);
      if (!files.length) {
        _filesModal.body.innerHTML = '<div class="alert alert-light border small mb-0">No files uploaded yet.</div>';
        return;
      }

      let h = '<div class="list-group list-group-flush">';
      files.forEach(function (f, idx) {
        const fileName = f && (f.name || f.stored_name) ? (f.name || f.stored_name) : 'file';
        const sizeText = f && typeof f.size === 'number' ? ('size: ' + f.size + ' bytes') : '';
        const stored = f && f.stored_name ? String(f.stored_name) : '';
        const dl = stored
          ? '/api/example-board/server/cards/' + encodeURIComponent(nodeId) + '/files/' + idx + '?sn=' + encodeURIComponent(stored)
          : null;
        h += '<div class="list-group-item d-flex align-items-center justify-content-between gap-2">';
        h += '<div class="text-truncate"><div class="small fw-medium">' + _esc(fileName) + '</div>';
        h += '<div class="small text-muted">' + _esc(sizeText) + '</div></div>';
        if (dl) {
          h += '<a class="btn btn-sm btn-outline-secondary flex-shrink-0" href="' + dl + '">Download</a>';
        }
        h += '</div>';
      });
      h += '</div>';
      _filesModal.body.innerHTML = h;
    }

    function openFilesModal(nodeId) {
      _ensureFilesModal();
      const node = cfg.resolve(nodeId);
      if (!node) return;

      const title = (node.card && node.card.meta && node.card.meta.title) || node.id;
      _filesModal.currentNodeId = nodeId;
      _filesModal.title.textContent = 'Files: ' + title;
      _filesModal.backdrop.classList.add('lc-open');

      // Disable upload controls when card_data.features.files.disabled is true
      const filesDisabled = !!(node.card_data && node.card_data.features && node.card_data.features.files && node.card_data.features.files.disabled);
      _filesModal.dropzone.classList.toggle('lc-disabled', filesDisabled);
      _filesModal.attachBtn.disabled = filesDisabled;
      _filesModal.uploadBtn.disabled = filesDisabled;
      _filesModal.fileInput.disabled = filesDisabled;

      _refreshFilesModalList(nodeId);

      if (_filesModal.pollingTimer) clearInterval(_filesModal.pollingTimer);
      _filesModal.pollingTimer = setInterval(function () {
        _refreshFilesModalList(nodeId);
      }, 1000);
    }

    function _resolveBind(node, bind) {
      if (!bind || typeof bind !== 'string') return undefined;
      const parts = _pathParts(bind);
      if (!parts.length) return undefined;

      const root = parts[0];
      const rest = parts.slice(1).join('.');
      const ns = {
        card: node && node.card ? node.card : {},
        card_data: node && node.card_data ? node.card_data : {},
        fetched_sources: node && node.fetched_sources ? node.fetched_sources : {},
        requires: node && node.requires ? node.requires : {},
        computed_values: node && node.computed_values ? node.computed_values : {},
        runtime_state: node && node.runtime_state ? node.runtime_state : {},
        data_objects: node && node.data_objects ? node.data_objects : {},
      };

      if (!Object.prototype.hasOwnProperty.call(ns, root)) return undefined;
      return rest ? _deepGet(ns[root], rest) : ns[root];
    }

    // ---- Pub/sub ----

    function notify(nodeId, data) {
      const cbs = _subs[nodeId];
      if (cbs) cbs.forEach(cb => { try { cb(nodeId, data); } catch (e) { console.error('LiveCard notify error', e); } });
    }

    function subscribe(nodeId, cb) {
      if (!_subs[nodeId]) _subs[nodeId] = new Set();
      _subs[nodeId].add(cb);
      return () => _subs[nodeId].delete(cb);
    }

    function _autoSubscribe(node) {
      const requires = (node && node.card && Array.isArray(node.card.requires)) ? node.card.requires : [];
      if (!requires.length) return;
      const cleanup = _getCleanup(node.id);
      cleanup.unsubs = requires.map(upId => subscribe(upId, () => {
        const info = _nodeEls[node.id];
        if (!info || !info.resultEl) return;
        const updated = cfg.resolve(node.id);
        if (!updated) return;
        _renderElements(updated, info.resultEl);
        notify(node.id);
      }));
    }

    // ===========================================================================
    // Element renderers — each: (data, el, elemDef, node)
    // ===========================================================================

    // ---- table ----

    function _renderTable(data, el, elemDef, node) {
      const ed = elemDef.data || {};
      if (!Array.isArray(data) || !data.length) {
        el.innerHTML = `<p class="text-muted small">${_esc(ed.placeholder || 'No data')}</p>`;
        return;
      }

      const limit = Math.min(data.length, ed.maxRows || 200);
      const colSet = new Set();
      for (let i = 0; i < Math.min(data.length, limit); i++) Object.keys(data[i]).forEach(k => colSet.add(k));
      const cols = (ed.columns && ed.columns.length) ? ed.columns : [...colSet];
      const sortable = ed.sortable !== false;

      let sortCol = null, sortDir = 'asc';
      const cleanup = _getCleanup(node.id);

      function build() {
        let rows = data.slice(0, limit);
        if (sortCol !== null && sortable) {
          rows = rows.slice().sort((a, b) => {
            const av = a[cols[sortCol]], bv = b[cols[sortCol]];
            if (av == null) return 1; if (bv == null) return -1;
            if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
            return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
          });
        }

        let h = '<div class="table-responsive"><table class="table table-sm table-striped table-hover mb-0"><thead><tr>';
        cols.forEach((c, i) => {
          const arrow = sortCol === i ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
          const cursor = sortable ? ' style="cursor:pointer"' : '';
          h += `<th class="small text-nowrap"${cursor} data-col="${i}">${_esc(c)}${arrow}</th>`;
        });
        h += '</tr></thead><tbody>';
        rows.forEach(row => {
          h += '<tr>';
          cols.forEach(c => { const v = row[c]; h += `<td class="small">${_esc(v != null ? String(v) : '')}</td>`; });
          h += '</tr>';
        });
        h += '</tbody></table></div>';
        if (data.length > limit) h += `<p class="text-muted small mt-1">Showing ${limit} of ${data.length} rows</p>`;
        el.innerHTML = h;

        if (sortable) {
          el.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
              const c = parseInt(th.dataset.col);
              if (sortCol === c) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
              else { sortCol = c; sortDir = 'asc'; }
              build();
            }, { signal: cleanup.ac.signal });
          });
        }
      }
      build();
    }

    // ---- filter ----

    function _renderFilter(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const writeTo = ed.writeTo;
      const values = writeTo ? (_resolveBind(node, writeTo) || {}) : {};
      const fields = (ed.fields && ed.fields.properties) || {};

      const keys = (data && typeof data === 'object' && !Array.isArray(data)) ? Object.keys(data) : [];
      if (!keys.length) { el.innerHTML = '<p class="text-muted small">No filter options</p>'; return; }

      let h = '<div class="row g-2">';
      keys.forEach(key => {
        const options = Array.isArray(data[key]) ? data[key] : [];
        const label = (fields[key] && fields[key].title) || key;
        h += `<div class="col-12 col-sm-6 col-md-4"><label class="form-label small mb-1">${_esc(label)}</label>`;
        h += `<select class="form-select form-select-sm" data-fk="${_esc(key)}"><option value="">All</option>`;
        options.forEach(opt => {
          const sel = String(opt) === String(values[key] || '') ? ' selected' : '';
          h += `<option value="${_esc(String(opt))}"${sel}>${_esc(String(opt))}</option>`;
        });
        h += '</select></div>';
      });
      h += '</div>';
      el.innerHTML = h;

      el.querySelectorAll('select[data-fk]').forEach(sel => {
        sel.addEventListener('change', () => {
          const nv = {};
          el.querySelectorAll('select[data-fk]').forEach(s => { if (s.value) nv[s.dataset.fk] = s.value; });
          if (writeTo) _deepSet(node, writeTo, nv);
          cfg.onPatchState(node.id, { fieldValues: nv });
          notify(node.id, nv);
        }, { signal });
      });
    }

    // ---- metric ----

    function _renderMetric(data, el, elemDef) {
      let title = elemDef.label || '', value = '—', detail = '';
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        title = data.title || data.label || data.metric || title;
        value = data.value != null ? String(data.value) : '—';
        detail = data.detail || '';
      } else if (data != null) {
        value = String(data);
      }
      let h = '<div class="text-center py-2">';
      if (title) h += `<div class="text-muted small">${_esc(title)}</div>`;
      h += `<div class="lc-metric-value">${_esc(value)}</div>`;
      if (detail) h += `<div class="small mt-1">${_renderMd(detail)}</div>`;
      h += '</div>';
      el.innerHTML = h;
    }

    // ---- list ----

    function _renderList(data, el, elemDef, node) {
      const ed = elemDef.data || {};
      if (data == null) { el.innerHTML = ''; return; }

      if (typeof data === 'object' && !Array.isArray(data)) {
        let h = '<dl class="row mb-0">';
        Object.entries(data).forEach(([k, v]) => {
          h += `<dt class="col-sm-5 small text-muted text-truncate">${_esc(k)}</dt>`;
          h += `<dd class="col-sm-7 small mb-1">${_esc(v != null ? String(v) : '—')}</dd>`;
        });
        el.innerHTML = h + '</dl>';
        return;
      }

      if (Array.isArray(data)) {
        if (!data.length) { el.innerHTML = `<p class="text-muted small">${_esc(ed.placeholder || 'Empty')}</p>`; return; }
        if (typeof data[0] === 'string' || typeof data[0] === 'number') {
          const max = ed.maxRows || data.length;
          let h = '<ul class="list-unstyled mb-0">';
          data.slice(0, max).forEach(item => { h += `<li class="small mb-1">• ${_esc(String(item))}</li>`; });
          el.innerHTML = h + '</ul>';
          return;
        }
        _renderTable(data, el, elemDef, node);
        return;
      }

      el.innerHTML = `<div class="small">${_renderMd(String(data))}</div>`;
    }

    // ---- chart ----

    function _renderChart(data, el, elemDef, node) {
      const ed = elemDef.data || {};
      if (!cfg.chartLib) { _renderTable(data, el, elemDef, node); return; }
      if (!Array.isArray(data) || !data.length) { el.innerHTML = '<p class="text-muted small">No chart data</p>'; return; }

      const cleanup = _getCleanup(node.id);
      const chartKey = elemDef.id || ('chart-' + Math.random().toString(36).slice(2, 8));
      const existingIdx = cleanup.charts.findIndex(c => c.key === chartKey);
      if (existingIdx >= 0) { cleanup.charts[existingIdx].inst.destroy(); cleanup.charts.splice(existingIdx, 1); }

      const type = ed.chartType || _detectChartType(data);
      el.innerHTML = '<div class="lc-chart-wrap"><canvas></canvas></div>';
      const ctx = el.querySelector('canvas').getContext('2d');

      let chartCfg;
      if (type === 'pie' || type === 'doughnut') {
        chartCfg = {
          type,
          data: {
            labels: data.map(r => r.label || r.name || ''),
            datasets: [{ data: data.map(r => r.value || 0), backgroundColor: _chartColors.slice(0, data.length) }],
          },
        };
      } else if (type === 'line') {
        chartCfg = {
          type: 'line',
          data: {
            labels: data.map(r => r.x || r.date || r.label || ''),
            datasets: [{ label: elemDef.label || 'Value', data: data.map(r => r.y || r.value || 0), borderColor: _chartColors[0], tension: 0.3, fill: false }],
          },
        };
      } else {
        const numKeys = Object.keys(data[0]).filter(k => typeof data[0][k] === 'number');
        const labelKey = Object.keys(data[0]).find(k => typeof data[0][k] === 'string');
        chartCfg = {
          type: 'bar',
          data: {
            labels: data.map(r => r.label || r.name || (labelKey ? r[labelKey] : '')),
            datasets: numKeys.map((k, i) => ({ label: k, data: data.map(r => r[k] || 0), backgroundColor: _chartColors[i % _chartColors.length] })),
          },
        };
      }
      chartCfg.options = Object.assign({
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: data.length > 8 ? 'bottom' : 'right' } },
      }, ed.chartOptions || {});

      cleanup.charts.push({ key: chartKey, inst: new cfg.chartLib(ctx, chartCfg) });
    }

    // ---- form ----

    function _renderForm(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const writeTo = ed.writeTo;
      const schema = ed.fields || {};
      const props = schema.properties || {};
      const required = schema.required || [];

      // --- Journal-style dirty tracking (mirrors editable-table) ---
      // currentState = what the server last sent (updated each SSE re-render)
      // pending      = user's local field values accumulated on top of currentState
      // dirty        = JSON.stringify(currentState) !== JSON.stringify(pending)
      //
      // On SSE re-render:
      //   - currentState updated to new server values
      //   - if NOT dirty: pending follows currentState (no unsaved edits)
      //   - if dirty: pending untouched, form is rebuilt from pending (edits survive)
      const stateKey = node.id + ':' + (writeTo || '');
      const incomingValues = writeTo ? (_resolveBind(node, writeTo) || {}) : (data && typeof data === 'object' ? data : {});
      const incomingCopy = Object.assign({}, incomingValues);

      if (!_formState[stateKey]) {
        _formState[stateKey] = { currentState: incomingCopy, pending: Object.assign({}, incomingCopy) };
      } else {
        const s = _formState[stateKey];
        const wasDirty = JSON.stringify(s.currentState) !== JSON.stringify(s.pending);
        s.currentState = incomingCopy;
        if (!wasDirty) {
          s.pending = Object.assign({}, incomingCopy);
        }
        // if dirty, pending stays so user's in-progress edits survive the SSE tick
      }

      const st = _formState[stateKey];

      function isDirty() {
        return JSON.stringify(st.currentState) !== JSON.stringify(st.pending);
      }

      // Snapshot current input values into pending (called on each input event)
      function capturePending(form) {
        form.querySelectorAll('[data-key]').forEach(inp => {
          const k = inp.dataset.key, p = props[k];
          if (!p) return;
          if (p.type === 'boolean') st.pending[k] = inp.checked;
          else if (p.type === 'number' || p.type === 'integer') st.pending[k] = inp.value !== '' ? parseFloat(inp.value) : 0;
          else st.pending[k] = inp.value;
        });
      }

      const form = document.createElement('form');
      form.className = 'row g-2';
      form.noValidate = true;

      Object.keys(props).forEach(key => {
        const prop = props[key];
        const isReq = required.indexOf(key) >= 0;
        const compact = ['number', 'integer', 'boolean'].includes(prop.type) || prop.enum || prop.format === 'date';
        const col = document.createElement('div');
        col.className = compact ? 'col-12 col-md-6' : 'col-12';

        let input;
        if (prop.type === 'boolean') {
          const wrap = document.createElement('div');
          wrap.className = 'form-check mt-3';
          input = document.createElement('input');
          input.type = 'checkbox'; input.className = 'form-check-input';
          const lbl = document.createElement('label');
          lbl.className = 'form-check-label small'; lbl.textContent = prop.title || key;
          wrap.appendChild(input); wrap.appendChild(lbl); col.appendChild(wrap);
        } else {
          const lbl = document.createElement('label');
          lbl.className = 'form-label small mb-1'; lbl.textContent = prop.title || key;
          col.appendChild(lbl);

          if (prop.enum) {
            input = document.createElement('select');
            input.className = 'form-select form-select-sm';
            prop.enum.forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; input.appendChild(opt); });
          } else if (prop.type === 'number' || prop.type === 'integer') {
            input = document.createElement('input');
            input.type = 'number'; input.className = 'form-control form-control-sm';
            if (prop.minimum != null) input.min = prop.minimum;
            if (prop.maximum != null) input.max = prop.maximum;
            if (prop.type === 'integer') input.step = '1';
          } else if (prop.format === 'date') {
            input = document.createElement('input');
            input.type = 'date'; input.className = 'form-control form-control-sm';
          } else {
            input = document.createElement('input');
            input.type = 'text'; input.className = 'form-control form-control-sm';
            if (prop.placeholder) input.placeholder = prop.placeholder;
          }
          col.appendChild(input);
        }

        input.dataset.key = key;
        if (isReq) input.required = true;
        // Populate from pending (not from server values directly)
        const v = st.pending[key];
        if (v != null) {
          if (prop.type === 'boolean') input.checked = !!v;
          else if (prop.format === 'date') input.value = String(v).slice(0, 10);
          else input.value = v;
        }
        form.appendChild(col);
      });

      const btnCol = document.createElement('div');
      btnCol.className = 'col-12 mt-1';
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.className = 'btn btn-sm btn-primary' + (isDirty() ? '' : ' d-none');
      btn.textContent = 'Submit';
      btnCol.appendChild(btn);
      form.appendChild(btnCol);

      el.innerHTML = '';
      el.appendChild(form);

      // Real-time input → update pending + show Submit if now dirty
      form.addEventListener('input', () => {
        capturePending(form);
        if (isDirty()) btn.classList.remove('d-none');
      }, { signal });

      form.addEventListener('submit', e => {
        e.preventDefault();
        if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
        capturePending(form);
        if (writeTo) _deepSet(node, writeTo, st.pending);
        cfg.onPatchState(node.id, { fieldValues: st.pending });
        notify(node.id, st.pending);
        // After save, currentState = pending (no longer dirty)
        st.currentState = Object.assign({}, st.pending);
        btn.classList.add('d-none');
        btn.textContent = '✓ Saved';
        setTimeout(() => { btn.textContent = 'Submit'; }, 1500);
      }, { signal });
    }

    // ---- notes ----

    function _renderNotes(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const writeTo = ed.writeTo;
      const incomingContent = typeof data === 'string' ? data : '';

      // --- Journal-style dirty tracking ---
      // currentState = last server value; pending = textarea content
      // On SSE re-render: if dirty, leave textarea alone; if clean, sync from server
      const stateKey = node.id + ':' + (writeTo || '');
      if (!_notesState[stateKey]) {
        _notesState[stateKey] = { currentState: incomingContent, pending: incomingContent };
      } else {
        const s = _notesState[stateKey];
        const wasDirty = s.currentState !== s.pending;
        s.currentState = incomingContent;
        if (!wasDirty) s.pending = incomingContent;
        // if dirty, pending stays so user's typing survives the SSE tick
      }
      const st = _notesState[stateKey];

      el.innerHTML = `
        <div class="btn-group btn-group-sm mb-2" role="group">
          <button class="btn btn-outline-secondary active lc-n-edit" type="button">Edit</button>
          <button class="btn btn-outline-secondary lc-n-preview" type="button">Preview</button>
        </div>
        <textarea class="form-control form-control-sm lc-notes-textarea" rows="8" placeholder="Write markdown...">${_esc(st.pending)}</textarea>
        <div class="lc-notes-preview d-none border rounded p-2 small"></div>`;

      const textarea = el.querySelector('.lc-notes-textarea');
      const preview = el.querySelector('.lc-notes-preview');
      const editBtn = el.querySelector('.lc-n-edit');
      const previewBtn = el.querySelector('.lc-n-preview');

      editBtn.addEventListener('click', () => {
        textarea.classList.remove('d-none'); preview.classList.add('d-none');
        editBtn.classList.add('active'); previewBtn.classList.remove('active');
      }, { signal });
      previewBtn.addEventListener('click', () => {
        preview.innerHTML = _renderMd(textarea.value);
        textarea.classList.add('d-none'); preview.classList.remove('d-none');
        previewBtn.classList.add('active'); editBtn.classList.remove('active');
      }, { signal });

      let timer;
      textarea.addEventListener('input', () => {
        st.pending = textarea.value; // track in journal
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (writeTo) _deepSet(node, writeTo, textarea.value);
          cfg.onPatchState(node.id, { notes: textarea.value });
          st.currentState = textarea.value; // saved — no longer dirty
        }, 800);
        cleanup.timers.push(timer);
      }, { signal });
    }

    // ---- todo ----

    // ---- editable-table ----
    // Renders an array bound via `data.bind` as an inline-editable table.
    // Each row is editable in-place; changes are saved on blur (change event).
    // `data.writeTo` persists changes back to card_data (same pattern as form).
    // `data.columns` restricts which columns appear (and in what order).
    // `data.schema.properties[col].type` ("number"/"integer") controls input type.
    // `data.addRow` (default true) shows "+ Add row" button.
    // `data.deleteRow` (default true) shows per-row delete button.
    function _renderEditableTable(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const writeTo = ed.writeTo;
      const schemaProps = (ed.schema && ed.schema.properties) || {};
      const canAdd    = ed.addRow    !== false;
      const canDelete = ed.deleteRow !== false;

      // Derive columns from rows if not specified
      function getCols(rows) {
        if (ed.columns && ed.columns.length) return ed.columns;
        const s = new Set();
        rows.forEach(r => { if (r && typeof r === 'object') Object.keys(r).forEach(k => s.add(k)); });
        return [...s];
      }

      // --- Journal-style dirty tracking ---
      // currentState = what the server last sent (updated each SSE re-render)
      // pending      = user's local accumulation of edits on top of currentState
      // dirty        = JSON.stringify(currentState) !== JSON.stringify(pending)
      //
      // When SSE fires and re-renders this element:
      //   - currentState is updated to the new server value
      //   - if NOT dirty: pending follows currentState (no unsaved edits)
      //   - if dirty: pending is left untouched (user's edits survive the SSE tick)
      const stateKey = node.id + ':' + (ed.bind || ed.writeTo || '');
      const incomingRows = Array.isArray(writeTo ? _resolveBind(node, writeTo) : data)
        ? (writeTo ? _resolveBind(node, writeTo) : data)
        : [];
      const incomingCopy = incomingRows.map(r => Object.assign({}, r));

      if (!_etState[stateKey]) {
        // First render — initialise both sides from server data
        _etState[stateKey] = { currentState: incomingCopy, pending: incomingCopy.map(r => Object.assign({}, r)) };
      } else {
        const s = _etState[stateKey];
        const wasDirty = JSON.stringify(s.currentState) !== JSON.stringify(s.pending);
        s.currentState = incomingCopy;
        if (!wasDirty) {
          // No unsaved edits — sync pending to new server state
          s.pending = incomingCopy.map(r => Object.assign({}, r));
        }
        // If dirty, pending stays as-is so user's edits survive the SSE tick
      }

      const st = _etState[stateKey];

      function isDirty() {
        return JSON.stringify(st.currentState) !== JSON.stringify(st.pending);
      }

      function markDirty() {
        const saveBtn = el.querySelector('.lc-et-save');
        if (saveBtn) saveBtn.classList.remove('d-none');
      }

      function commitSave() {
        if (writeTo) _deepSet(node, writeTo, st.pending);
        cfg.onPatchState(node.id, { fieldValues: st.pending });
        notify(node.id, st.pending);
        // After save, currentState = pending (no longer dirty)
        st.currentState = st.pending.map(r => Object.assign({}, r));
        build();
      }

      function build() {
        const rows = st.pending;
        const cols = getCols(rows);

        if (!cols.length && !canAdd) {
          el.innerHTML = `<p class="text-muted small">${_esc(ed.placeholder || 'No data')}</p>`;
          return;
        }

        let h = '<div class="table-responsive"><table class="table table-sm table-bordered mb-0 lc-editable-table"><thead><tr>';
        cols.forEach(c => { h += `<th class="small text-nowrap">${_esc(c)}</th>`; });
        if (canDelete) h += '<th style="width:2rem"></th>';
        h += '</tr></thead><tbody>';

        rows.forEach((row, rowIdx) => {
          h += `<tr>`;
          cols.forEach(c => {
            const v    = row[c];
            const prop = schemaProps[c] || {};
            const isNum = prop.type === 'number' || prop.type === 'integer' || (v != null && typeof v === 'number');
            const displayVal = v != null ? String(v) : '';
            h += `<td class="p-0">` +
              `<input type="${isNum ? 'number' : 'text'}" ` +
              `class="form-control form-control-sm border-0 rounded-0 lc-et-cell" ` +
              `data-row="${rowIdx}" data-col="${_esc(c)}" value="${_esc(displayVal)}"` +
              `${isNum ? ' step="any"' : ''}>` +
              `</td>`;
          });
          if (canDelete) {
            h += `<td class="text-center align-middle p-0">` +
              `<button class="btn btn-sm btn-link text-danger p-0 lc-et-del" data-row="${rowIdx}" title="Remove row">✕</button>` +
              `</td>`;
          }
          h += '</tr>';
        });

        if (!rows.length) {
          const span = cols.length + (canDelete ? 1 : 0);
          h += `<tr><td colspan="${span}" class="text-muted small text-center">${_esc(ed.placeholder || 'No rows')}</td></tr>`;
        }

        h += '</tbody></table></div>';
        let footer = '';
        if (canAdd) footer += '<button class="btn btn-sm btn-outline-secondary mt-1 me-1 lc-et-add">+ Add row</button>';
        footer += `<button class="btn btn-sm btn-primary mt-1 lc-et-save${isDirty() ? '' : ' d-none'}">Save</button>`;
        el.innerHTML = h + footer;

        // Cell edit → update pending on blur, show Save if now dirty
        el.querySelectorAll('.lc-et-cell').forEach(inp => {
          inp.addEventListener('change', () => {
            const rowIdx  = parseInt(inp.dataset.row);
            const colName = inp.dataset.col;
            const prop    = schemaProps[colName] || {};
            const isNum   = prop.type === 'number' || prop.type === 'integer' || inp.type === 'number';
            if (!st.pending[rowIdx]) return;
            st.pending[rowIdx] = Object.assign({}, st.pending[rowIdx]);
            st.pending[rowIdx][colName] = isNum ? (inp.value !== '' ? parseFloat(inp.value) : 0) : inp.value;
            if (isDirty()) markDirty();
          }, { signal });
        });

        // Delete row — updates pending, rebuilds (Save button shown if dirty)
        el.querySelectorAll('.lc-et-del').forEach(btn => {
          btn.addEventListener('click', () => {
            const rowIdx = parseInt(btn.dataset.row);
            st.pending = st.pending.filter((_, i) => i !== rowIdx);
            build();
          }, { signal });
        });

        // Add row — appends blank row to pending, rebuilds (Save button shown if dirty)
        const addBtn = el.querySelector('.lc-et-add');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            const newRow = {};
            getCols(st.pending).forEach(c => { newRow[c] = ''; });
            st.pending = [...st.pending, newRow];
            build();
          }, { signal });
        }

        // Save button — persist pending to server via fieldValues (same as form submit)
        const saveBtn = el.querySelector('.lc-et-save');
        if (saveBtn) {
          saveBtn.addEventListener('click', () => {
            commitSave();
            saveBtn.textContent = '✓ Saved';
            setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
          }, { signal });
        }
      }

      build();
    }

    // ---- todo ----

    function _renderTodo(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const writeTo = ed.writeTo;

      // --- Journal-style dirty tracking ---
      // currentState = last confirmed server state; pending = local working copy
      // On SSE re-render: if dirty (action in-flight), keep pending; if clean, sync from server
      const stateKey = node.id + ':' + (writeTo || '');
      const incomingItems = Array.isArray(data) ? data.map(r => Object.assign({}, r)) : [];

      if (!_todoState[stateKey]) {
        _todoState[stateKey] = { currentState: incomingItems, pending: incomingItems.map(r => Object.assign({}, r)) };
      } else {
        const s = _todoState[stateKey];
        const wasDirty = JSON.stringify(s.currentState) !== JSON.stringify(s.pending);
        s.currentState = incomingItems;
        if (!wasDirty) s.pending = incomingItems.map(r => Object.assign({}, r));
        // if dirty, pending stays so in-flight changes survive the SSE tick
      }
      const st = _todoState[stateKey];

      function save() {
        if (writeTo) _deepSet(node, writeTo, st.pending);
        cfg.onPatchState(node.id, { fieldValues: st.pending });
        notify(node.id, st.pending);
        // mark clean after save so next SSE sync resumes normally
        st.currentState = st.pending.map(r => Object.assign({}, r));
      }

      function build() {
        const items = st.pending;
        let h = '<div class="lc-todo-list">';
        items.forEach((item, i) => {
          const chk = item.done ? ' checked' : '';
          const strike = item.done ? ' text-decoration-line-through text-muted' : '';
          h += `<div class="lc-todo-item">`;
          h += `<input class="form-check-input flex-shrink-0" type="checkbox"${chk} data-idx="${i}">`;
          h += `<span class="small flex-grow-1${strike}">${_esc(item.text)}</span>`;
          h += `<button class="btn btn-sm btn-link text-danger p-0" data-rm="${i}" title="Remove">×</button></div>`;
        });
        h += '</div>';
        h += '<div class="input-group input-group-sm mt-2"><input type="text" class="form-control" placeholder="Add item...">';
        h += '<button class="btn btn-outline-secondary lc-todo-add">+</button></div>';
        el.innerHTML = h;

        el.querySelectorAll('input[data-idx]').forEach(cb => {
          cb.addEventListener('change', () => {
            st.pending[parseInt(cb.dataset.idx)].done = cb.checked;
            save(); build();
          }, { signal });
        });
        el.querySelectorAll('[data-rm]').forEach(btn => {
          btn.addEventListener('click', () => {
            st.pending.splice(parseInt(btn.dataset.rm), 1);
            save(); build();
          }, { signal });
        });
        const addInput = el.querySelector('.input-group input');
        const addBtn = el.querySelector('.lc-todo-add');
        const addItem = () => {
          const t = addInput.value.trim();
          if (!t) return;
          st.pending.push({ text: t, done: false });
          save(); build();
        };
        addBtn.addEventListener('click', addItem, { signal });
        addInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }, { signal });
      }
      build();
    }

    // ---- alert ----

    function _renderAlert(data, el, elemDef) {
      const ed = elemDef.data || {};
      const thresholds = ed.thresholds || {};
      const value = typeof data === 'number' ? data : (data && data.value != null ? data.value : null);

      let level = 'unknown', color = 'secondary';
      if (value != null) {
        if (thresholds.green && _evalThreshold(value, thresholds.green)) { level = 'green'; color = 'success'; }
        else if (thresholds.amber && _evalThreshold(value, thresholds.amber)) { level = 'amber'; color = 'warning'; }
        else { level = 'red'; color = 'danger'; }
      }

      el.innerHTML = `
        <div class="d-flex align-items-center gap-3 py-2">
          <span class="lc-alert-dot lc-alert-${level}"></span>
          <div class="flex-grow-1">
            <div class="fw-bold">${value != null ? _esc(String(value)) : '—'}</div>
            ${elemDef.label ? `<div class="text-muted small">${_esc(elemDef.label)}</div>` : ''}
          </div>
          <span class="badge bg-${color} fs-6">${_esc(level)}</span>
        </div>`;
    }

    // ---- narrative ----

    function _renderNarrative(data, el) {
      const text = typeof data === 'string' ? data : (data && data.text ? data.text : '');
      if (!text) { el.innerHTML = '<p class="text-muted small fst-italic">No narrative yet. Click refresh to generate.</p>'; return; }
      el.innerHTML = `<div class="small">${_renderMd(text)}</div>`;
    }

    // ---- badge ----

    function _renderBadge(data, el, elemDef) {
      const ed = elemDef.data || {};
      const map = ed.colorMap || {};
      const val = data != null ? String(data) : '';
      const bsMap = { green: 'success', amber: 'warning', red: 'danger', blue: 'primary' };
      const bs = bsMap[map[val]] || map[val] || 'secondary';
      el.innerHTML = `<span class="badge bg-${_esc(bs)}">${_esc(val)}</span>`;
    }

    // ---- text ----

    function _renderText(data, el, elemDef) {
      const ed = elemDef.data || {};
      const format = ed.format || 'default';
      const style = elemDef.style || ed.style || 'default';
      const hideIfEmpty = ed.hideIfEmpty || elemDef.hideIfEmpty;

      if (hideIfEmpty && (data == null || data === '')) { el.innerHTML = ''; return; }

      // Handle file-links format
      if (format === 'file-links') {
        if (!Array.isArray(data) || data.length === 0) {
          el.innerHTML = '<div class="text-muted small">No files uploaded</div>';
          return;
        }
        const htmlParts = [];
        data.forEach((file, idx) => {
          if (!file || !file.stored_name) return;
          const name = file.name || file.stored_name;
          const cardId = elemDef.data && elemDef.data.cardId ? elemDef.data.cardId : 'unknown';
          const downloadUrl = `/api/example-board/server/cards/${encodeURIComponent(cardId)}/files/${idx}?sn=${encodeURIComponent(file.stored_name)}`;
          const size = file.size ? ` (${Math.round(file.size / 1024)}KB)` : '';
          htmlParts.push(`<div class="mb-2"><a href="${downloadUrl}" class="btn btn-sm btn-outline-secondary">${_esc(name)}${_esc(size)}</a></div>`);
        });
        const html = htmlParts.join('');
        el.innerHTML = html;
        return;
      }

      // Default text rendering
      const tag = style === 'heading' ? 'h4' : 'div';
      const cls = style === 'muted' ? 'text-muted small'
        : style === 'muted-italic' ? 'text-muted small fst-italic'
        : style === 'heading' ? 'fw-bold'
        : 'small';
      el.innerHTML = `<${tag} class="${cls}">${_esc(data != null ? String(data) : '')}</${tag}>`;
    }

    // ---- markdown ----

    function _renderMarkdown(data, el) {
      let text = '';
      if (typeof data === 'string') text = data;
      else if (data && typeof data === 'object' && data.text) text = data.text;
      else if (data != null) text = JSON.stringify(data, null, 2);
      el.innerHTML = text ? _renderMd(text) : '';
    }

    // ---- custom (fallback to JSON) ----

    function _renderCustom(data, el) {
      if (data == null) { el.innerHTML = ''; return; }
      el.innerHTML = `<pre class="small mb-0">${_esc(JSON.stringify(data, null, 2))}</pre>`;
    }

    // ---- file-upload ----

    function _renderFileUpload(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const uploaded = Array.isArray(data) ? data : [];
      const showUploadedList = ed.showUploadedList === true;
      const showUpload = ed.upload !== false;
      const accept = ed.accept || ['.txt','.csv','.md','.json','.html','.xml','.pdf','.xlsx','.docx','.pptx','.png','.jpg','.jpeg'];
      const acceptSet = new Set(accept.map(e => e.toLowerCase()));
      const multiple = ed.multiple !== false;
      const placeholder = ed.placeholder || 'Drop files here or click to browse';
      const uid = 'lc-fu-' + (elemDef.id || Math.random().toString(36).slice(2, 8));

      let stagedFiles = el._stagedFiles || [];
      el._stagedFiles = stagedFiles;
      let uploadStatus = el._uploadStatus || {};
      el._uploadStatus = uploadStatus;

      function keyForFile(f) {
        return `${f.name}::${f.size}::${f.lastModified || 0}`;
      }

      let h = '';

      // Drop zone
      if (showUpload) {
        h += `<div class="lc-dropzone mb-2" id="${uid}-dz">`;
        h += '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-muted mb-1"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
        h += `<div class="small text-muted">${_esc(placeholder)}</div>`;
        h += `<input type="file" id="${uid}-fi" class="d-none"${multiple ? ' multiple' : ''} accept="${accept.join(',')}">`;
        h += '</div>';
        h += `<div id="${uid}-staged"></div>`;
      }

      // Uploaded files list
      if (showUploadedList && uploaded.length) {
        h += '<div class="lc-uploaded-files">';
        uploaded.forEach(f => {
          const name = typeof f === 'string' ? f : (f.name || '');
          const url = typeof f === 'string' ? null : f.url;
          h += '<div class="d-flex align-items-center gap-1 small mb-1">';
          h += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
          if (url) h += `<a href="${_esc(url)}" class="text-truncate" target="_blank" download>${_esc(name)}</a>`;
          else h += `<span class="text-truncate">${_esc(name)}</span>`;
          h += '</div>';
        });
        h += '</div>';
      }

      if (!showUpload && !uploaded.length) {
        h = `<p class="text-muted small">${_esc(ed.placeholder || 'No files')}</p>`;
      }

      el.innerHTML = h;

      if (!showUpload) {
        el._fileUpload = { getFiles: () => [], clear: () => {} };
        return;
      }

      const dz = el.querySelector('#' + uid + '-dz');
      const fi = el.querySelector('#' + uid + '-fi');
      const stagedEl = el.querySelector('#' + uid + '-staged');
      if (!dz) return;

      function addFiles(fileList) {
        const newlyAdded = [];
        for (const f of fileList) {
          const ext = '.' + f.name.split('.').pop().toLowerCase();
          if (!acceptSet.has(ext)) continue;
          if (!stagedFiles.find(s => s.name === f.name)) {
            stagedFiles.push(f);
            newlyAdded.push(f);
            uploadStatus[keyForFile(f)] = 'uploading';
          }
        }
        renderStaged();

        // Server demos can upload real file blobs immediately via onAction.
        if (newlyAdded.length && typeof cfg.onAction === 'function') {
          Promise.resolve(cfg.onAction(node.id, 'file-upload', { files: newlyAdded, elemId: elemDef.id }))
            .then(() => {
              const uploadedKeys = new Set(newlyAdded.map(keyForFile));
              stagedFiles = stagedFiles.filter((f) => !uploadedKeys.has(keyForFile(f)));
              el._stagedFiles = stagedFiles;
              newlyAdded.forEach((f) => { delete uploadStatus[keyForFile(f)]; });
              el._uploadStatus = uploadStatus;
              renderStaged();
            })
            .catch(() => {
              newlyAdded.forEach((f) => { uploadStatus[keyForFile(f)] = 'error'; });
              el._uploadStatus = uploadStatus;
              renderStaged();
            });
        }
      }

      function renderStaged() {
        if (!stagedFiles.length) { stagedEl.innerHTML = ''; return; }
        let sh = '';
        stagedFiles.forEach((f, i) => {
          const status = uploadStatus[keyForFile(f)] || 'ready';
          sh += '<div class="lc-staged-file">';
          sh += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
          sh += `<span class="small flex-grow-1 text-truncate">${_esc(f.name)}</span>`;
          if (status === 'uploading') {
            sh += '<span class="spinner-border spinner-border-sm text-secondary me-1" role="status" aria-label="Uploading"></span>';
          } else if (status === 'error') {
            sh += '<span class="badge bg-danger-subtle text-danger border border-danger-subtle me-1">Failed</span>';
          }
          sh += `<button class="btn btn-sm btn-link text-danger p-0 lc-rm-staged" data-idx="${i}">&times;</button>`;
          sh += '</div>';
        });
        stagedEl.innerHTML = sh;
        stagedEl.querySelectorAll('.lc-rm-staged').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const f = stagedFiles[idx];
            if (f) delete uploadStatus[keyForFile(f)];
            stagedFiles.splice(idx, 1);
            el._stagedFiles = stagedFiles;
            el._uploadStatus = uploadStatus;
            renderStaged();
          }, { signal });
        });
      }

      dz.addEventListener('click', () => fi.click(), { signal });
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('lc-drag-over'); }, { signal });
      dz.addEventListener('dragleave', () => dz.classList.remove('lc-drag-over'), { signal });
      dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('lc-drag-over'); addFiles(e.dataTransfer.files); }, { signal });
      fi.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; }, { signal });

      renderStaged();

      el._fileUpload = {
        getFiles: () => stagedFiles,
        clear: () => { stagedFiles = []; uploadStatus = {}; el._stagedFiles = []; el._uploadStatus = {}; renderStaged(); },
        disable: () => { dz.classList.add('lc-disabled'); fi.disabled = true; },
        enable: () => { dz.classList.remove('lc-disabled'); fi.disabled = false; },
      };
    }

    // ---- chat (element kind) ----

    function _renderChatEl(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const messages = Array.isArray(data) ? data : [];
      const placeholder = ed.placeholder || 'Type a message...';
      const canAttach = ed.fileAttach === true;
      const accept = ed.fileAccept || ['.txt','.csv','.md','.json','.html','.xml','.pdf','.xlsx','.docx','.pptx','.png','.jpg','.jpeg'];
      const uid = 'lc-ch-' + (elemDef.id || Math.random().toString(36).slice(2, 8));

      let h = '<div class="lc-chat-el">';
      h += `<div class="lc-chat-body" id="${uid}-body"></div>`;
      h += '<div class="lc-chat-input-bar">';
      if (canAttach) {
        h += `<input type="file" id="${uid}-fi" class="d-none" multiple accept="${accept.join(',')}">`;
        h += `<button class="btn btn-sm btn-outline-secondary" id="${uid}-attach" title="Attach files" type="button">`;
        h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';
        h += '</button>';
      }
      h += `<input type="text" class="form-control form-control-sm flex-grow-1" id="${uid}-input" placeholder="${_esc(placeholder)}">`;
      h += `<button class="btn btn-sm btn-outline-primary" id="${uid}-send" type="button">`;
      h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
      h += '</button></div>';
      if (canAttach) h += `<div id="${uid}-staged" class="mt-1"></div>`;
      h += '</div>';

      el.innerHTML = h;

      const body = el.querySelector('#' + uid + '-body');
      const input = el.querySelector('#' + uid + '-input');
      const sendBtn = el.querySelector('#' + uid + '-send');
      const attachBtn = canAttach ? el.querySelector('#' + uid + '-attach') : null;
      const fileInput = canAttach ? el.querySelector('#' + uid + '-fi') : null;
      const stagedEl = canAttach ? el.querySelector('#' + uid + '-staged') : null;

      let stagedFiles = [];

      function appendMsg(msg) {
        const bub = document.createElement('div');
        const roleClass = msg.role === 'user' ? 'lc-chat-bubble-user'
          : msg.role === 'assistant' ? 'lc-chat-bubble-assistant'
          : 'lc-chat-bubble-system';
        bub.className = 'lc-chat-bubble ' + roleClass;
        if (msg.role === 'assistant') {
          bub.innerHTML = _renderMd(msg.text || '');
        } else {
          bub.textContent = msg.text || '';
        }
        if (msg.files && msg.files.length) {
          const fDiv = document.createElement('div');
          fDiv.className = 'small mt-1';
          msg.files.forEach(f => {
            const name = typeof f === 'string' ? f : f.name;
            fDiv.innerHTML += '\uD83D\uDCCE ' + _esc(name) + '<br>';
          });
          bub.appendChild(fDiv);
        }
        body.appendChild(bub);
      }

      messages.forEach(appendMsg);
      body.scrollTop = body.scrollHeight;

      function renderStaged() {
        if (!stagedEl) return;
        if (!stagedFiles.length) { stagedEl.innerHTML = ''; return; }
        stagedEl.innerHTML = stagedFiles.map((f, i) =>
          `<div class="d-flex align-items-center gap-1 small"><span>\uD83D\uDCCE ${_esc(f.name)}</span><button class="btn btn-sm btn-link text-danger p-0 lc-rm-cs" data-idx="${i}">&times;</button></div>`
        ).join('');
        stagedEl.querySelectorAll('.lc-rm-cs').forEach(btn => {
          btn.addEventListener('click', () => { stagedFiles.splice(parseInt(btn.dataset.idx), 1); renderStaged(); }, { signal });
        });
      }

      if (attachBtn && fileInput) {
        const acceptS = new Set(accept.map(x => x.toLowerCase()));
        attachBtn.addEventListener('click', () => fileInput.click(), { signal });
        fileInput.addEventListener('change', e => {
          for (const f of e.target.files) {
            const ext = '.' + f.name.split('.').pop().toLowerCase();
            if (acceptS.has(ext) && !stagedFiles.find(s => s.name === f.name)) stagedFiles.push(f);
          }
          e.target.value = '';
          renderStaged();
        }, { signal });
      }

      function doSend() {
        const text = input.value.trim();
        if (!text && !stagedFiles.length) return;
        const msg = { role: 'user', text: text || '' };
        if (stagedFiles.length) msg.files = stagedFiles.map(f => ({ name: f.name, size: f.size }));
        appendMsg(msg);
        body.scrollTop = body.scrollHeight;
        input.value = '';
        const filesToSend = stagedFiles.slice();
        stagedFiles = [];
        renderStaged();
        cfg.onAction(node.id, 'chat-send', { text: msg.text, files: filesToSend, elemId: elemDef.id });
      }

      sendBtn.addEventListener('click', doSend, { signal });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }, { signal });

      el._chat = {
        appendMessage: (role, text, files) => { appendMsg({ role, text, files }); body.scrollTop = body.scrollHeight; },
        showProcessing: (text) => {
          let ind = body.querySelector('.lc-chat-processing');
          if (!ind) {
            ind = document.createElement('div');
            ind.className = 'lc-chat-processing';
            ind.innerHTML = '<span class="spinner-border spinner-border-sm"></span><span class="small">Processing...</span>';
            body.appendChild(ind);
          }
          if (text) ind.querySelector('.small').textContent = text;
          body.scrollTop = body.scrollHeight;
        },
        removeProcessing: () => { const ind = body.querySelector('.lc-chat-processing'); if (ind) ind.remove(); },
        disable: () => { input.disabled = true; sendBtn.disabled = true; if (attachBtn) attachBtn.disabled = true; },
        enable: () => { input.disabled = false; sendBtn.disabled = false; if (attachBtn) attachBtn.disabled = false; },
      };
    }

    // ---- actions ----

    function _renderActions(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const buttons = ed.buttons || (Array.isArray(data) ? data : []);
      if (!buttons.length) { el.innerHTML = ''; return; }

      let h = '<div class="d-flex gap-2 flex-wrap">';
      buttons.forEach(btn => {
        const style = btn.style || 'outline-secondary';
        const size = btn.size || 'sm';
        const dis = typeof btn.disabled === 'string' ? _resolveBind(node, btn.disabled) : btn.disabled;
        h += `<button class="btn btn-${_esc(style)} btn-${size}" data-action-id="${_esc(btn.id)}"${dis ? ' disabled' : ''}>`;
        h += _esc(btn.label || btn.id);
        h += '</button>';
      });
      h += '</div>';
      el.innerHTML = h;

      el.querySelectorAll('[data-action-id]').forEach(btnEl => {
        btnEl.addEventListener('click', () => {
          cfg.onAction(node.id, 'action', { buttonId: btnEl.dataset.actionId, elemId: elemDef.id });
        }, { signal });
      });

      el._actions = {
        setDisabled: (buttonId, disabled) => {
          const b = el.querySelector(`[data-action-id="${buttonId}"]`);
          if (b) b.disabled = disabled;
        },
        setLabel: (buttonId, label) => {
          const b = el.querySelector(`[data-action-id="${buttonId}"]`);
          if (b) b.textContent = label;
        },
      };
    }

    // ---- Register built-in renderers ----

    _renderers.table          = _renderTable;
    _renderers['editable-table'] = _renderEditableTable;
    _renderers.filter         = _renderFilter;
    _renderers.metric    = _renderMetric;
    _renderers.list      = _renderList;
    _renderers.chart     = _renderChart;
    _renderers.form      = _renderForm;
    _renderers.notes     = _renderNotes;
    _renderers.todo      = _renderTodo;
    _renderers.alert     = _renderAlert;
    _renderers.narrative = _renderNarrative;
    _renderers.badge     = _renderBadge;
    _renderers.text      = _renderText;
    _renderers.markdown  = _renderMarkdown;
    _renderers.custom    = _renderCustom;
    _renderers['file-upload'] = _renderFileUpload;
    _renderers['chat']        = _renderChatEl;
    _renderers.actions        = _renderActions;

    // ===========================================================================
    // _renderElements — render all view.elements for a card node
    // ===========================================================================

    function _renderElements(node, containerEl) {
      const view = node && node.card ? node.card.view : null;
      if (!view || !Array.isArray(view.elements)) { containerEl.innerHTML = ''; return; }

      if (_nodeEls[node.id]) _nodeEls[node.id].elements = {};

      const container = document.createElement('div');
      container.className = 'row g-2';

      const _taskStatus = node.runtime_state && node.runtime_state.task_status;
      if (_taskStatus && _taskStatus !== 'completed') {
        const statusEl = document.createElement('div');
        statusEl.className = 'col-12 d-flex align-items-center gap-2 mb-1';
        var _statusIconHtml;
        if (_taskStatus === 'running') {
          _statusIconHtml = '<span class="spinner-border spinner-border-sm text-muted" style="width:.75rem;height:.75rem;flex-shrink:0"></span>';
        } else if (_taskStatus === 'failed') {
          _statusIconHtml = '<span style="font-size:.75rem;line-height:1;flex-shrink:0;color:#dc3545">&#x26A0;&#xFE0E;</span>'; // ⚠ (text variant)
        } else if (_taskStatus === 'not-started') {
          _statusIconHtml = '<span style="font-size:.75rem;line-height:1;flex-shrink:0" class="text-muted">&#x25CB;</span>'; // ○
        } else if (_taskStatus === 'inactivated') {
          _statusIconHtml = '<span style="font-size:.75rem;line-height:1;flex-shrink:0" class="text-muted">&#x2296;</span>'; // ⊖
        } else {
          _statusIconHtml = '<span style="font-size:.75rem;line-height:1;flex-shrink:0" class="text-muted">&#x2013;</span>'; // –
        }
        statusEl.innerHTML = _statusIconHtml + '<span class="text-muted" style="font-size:.75rem">' + _esc(_taskStatus) + '</span>';
        container.appendChild(statusEl);
      }

      view.elements.forEach(elemDef => {
        // Visibility gate
        if (elemDef.visible) {
          const vis = _resolveBind(node, elemDef.visible);
          if (!vis) return;
        }

        const data = elemDef.data && elemDef.data.bind ? _resolveBind(node, elemDef.data.bind) : undefined;
        const col = document.createElement('div');
        col.className = elemDef.className || 'col-12';

        // Element label (except metric which handles its own)
        if (elemDef.label && elemDef.kind !== 'metric' && elemDef.kind !== 'alert') {
          const label = document.createElement('div');
          label.className = 'small text-muted fw-medium mb-1';
          label.textContent = elemDef.label;
          col.appendChild(label);
        }

        const inner = document.createElement('div');
        col.appendChild(inner);

        const renderer = _renderers[elemDef.kind] || _renderers.custom;
        try {
          renderer(data, inner, elemDef, node);
        } catch (e) {
          console.error('LiveCard render error', node.id, elemDef.kind, e);
          inner.innerHTML = `<div class="text-danger small">Render error: ${_esc(e.message)}</div>`;
        }

        if (elemDef.id && _nodeEls[node.id]) _nodeEls[node.id].elements[elemDef.id] = inner;

        container.appendChild(col);
      });

      containerEl.innerHTML = '';
      containerEl.appendChild(container);
    }

    // ===========================================================================
    // Core render
    // ===========================================================================

    function render(node, containerEl, opts) {
      opts = opts || {};
      destroy(node.id);

      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const uid = 'lc-' + (node.id || 'x');
      const features = (node.card && node.card.view && node.card.view.features) || {};

      // Run compute async before populating elements
      // (compute is triggered in the else branch below after DOM is ready)

      let h = `<div class="lc-card" id="${uid}">`;

      // Header bar: status dot + time-ago + refresh button
      const showRefresh = features.refresh !== false && cfg.onRefresh;
      h += `<div class="d-flex align-items-center gap-1 mb-2">`;
      h += _statusDot(node.card_data && node.card_data.status);
      h += `<span class="text-muted small">${_timeAgo(node.card_data && node.card_data.lastRun)}</span>`;
      if (node.card_data && node.card_data.status === 'error' && node.card_data.error) {
        h += `<span class="badge bg-danger small" title="${_esc(node.card_data.error)}">Error</span>`;
      }
      h += '<div class="d-flex align-items-center gap-1 ms-auto">';
      const filesCount = (node && node.card_data && Array.isArray(node.card_data.files)) ? node.card_data.files.length : 0;
      // Files icon button (paperclip)
      h += `<button class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center" id="${uid}-files-open" title="${filesCount > 0 ? 'Files (' + filesCount + ')' : 'Files'}">`;
      h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';
      if (filesCount > 0) h += `<span class="ms-1 small" aria-label="${filesCount} files">${filesCount}</span>`;
      h += '</button>';
      // Chat icon button (speech bubble)
      h += `<button class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center" id="${uid}-chat-open" title="Chat">`;
      h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
      h += '</button>';
      // Refresh icon button
      if (showRefresh) {
        h += `<button class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center" id="${uid}-refresh" title="Refresh">`;
        h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
        h += '</button>';
      }
      h += '</div>';
      h += '</div>';

      // Inference status bar: completion criteria + task-completed tick
      const inferenceData = node.card_data && node.card_data.llm_task_completion_inference;
      const isTaskCompleted = !!(inferenceData && inferenceData.isTaskCompleted);
      const whenIs = node.card && typeof node.card.when_is_task_completed === 'string' && node.card.when_is_task_completed.trim();
      if (whenIs || isTaskCompleted) {
        h += `<div class="d-flex align-items-start gap-2 mb-2 px-1 py-1 rounded lc-inference-bar" style="background:rgba(0,0,0,.03)">`;
        if (isTaskCompleted) {
          h += `<span class="lc-inference-icon" title="Task completed" style="color:#198754;font-size:.75rem;line-height:1.2;flex-shrink:0">&#x25CF;</span>`;
        } else {
          h += `<span class="lc-inference-icon" style="color:#aaa;font-size:.75rem;line-height:1.4;flex-shrink:0" title="Awaiting inference">&#x25CB;</span>`;
        }
        if (whenIs) {
          h += `<span class="text-muted" style="font-size:.72rem;line-height:1.4;font-style:italic"><span style="opacity:.55;font-style:normal">done when:</span> ${_esc(whenIs)}</span>`;
        }
        h += `</div>`;
      }

      // Elements area
      h += `<div class="lc-result" id="${uid}-result"></div>`;

      // Notes section (feature toggle)
      if (features.notes && opts.showNotes !== false) {
        h += `<details class="mt-2"><summary class="small fw-medium">Notes</summary>`;
        h += `<textarea class="form-control form-control-sm mt-1" id="${uid}-notes" rows="3" placeholder="Add notes...">${_esc((node.card_data && node.card_data._notes) || '')}</textarea></details>`;
      }

      h += '</div>';
      containerEl.innerHTML = h;

      // ---- Render elements ----
      const resultEl = document.getElementById(uid + '-result');
      _nodeEls[node.id] = { container: containerEl, resultEl, uid };

      if (node.card_data && node.card_data.status === 'error' && node.card_data.error) {
        resultEl.innerHTML = `<div class="text-danger small fw-semibold">Refresh failed</div><pre class="text-muted small mt-1" style="white-space:pre-wrap">${_esc(node.card_data.error)}</pre>`;
      } else {
        _runCompute(node).then(function () { _renderElements(node, resultEl); });
      }

      // ---- Wire refresh ----
      const refreshBtn = document.getElementById(uid + '-refresh');
      if (refreshBtn && cfg.onRefresh) {
        refreshBtn.addEventListener('click', e => {
          e.stopPropagation();
          refreshBtn.disabled = true;
          cfg.onRefresh(node.id);
        }, { signal });
      }

      const chatBtn = document.getElementById(uid + '-chat-open');
      if (chatBtn) {
        chatBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openChatModal(node.id);
        }, { signal });
      }

      const filesBtn = document.getElementById(uid + '-files-open');
      if (filesBtn) {
        filesBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openFilesModal(node.id);
        }, { signal });
      }

      // ---- Wire notes ----
      const notesEl = document.getElementById(uid + '-notes');
      if (notesEl) {
        let nTimer;
        notesEl.addEventListener('input', () => {
          clearTimeout(nTimer);
          nTimer = setTimeout(() => {
            if (!node.card_data) node.card_data = {};
            node.card_data._notes = notesEl.value;
            cfg.onPatch(node.id, { _notes: notesEl.value });
          }, 800);
          cleanup.timers.push(nTimer);
        }, { signal });
      }

      _autoSubscribe(node);
    }

    // ===========================================================================
    // In-place update
    // ===========================================================================

    function update(nodeId, patch) {
      const info = _nodeEls[nodeId];
      if (!info) return;

      const refreshBtn = document.getElementById(info.uid + '-refresh');
      if (refreshBtn) refreshBtn.disabled = false;

      // Update status dot
      if (patch.status) {
        const dot = info.container.querySelector('.lc-status-dot');
        if (dot) {
          const c = { fresh: 'var(--bs-success)', stale: 'var(--bs-warning)', error: 'var(--bs-danger)', loading: 'var(--bs-info)' };
          dot.style.background = c[patch.status] || 'var(--bs-secondary)';
          dot.title = patch.status;
        }
      }

      if (patch.lastRun) {
        const ts = info.container.querySelector('.lc-status-dot + .text-muted');
        if (ts) ts.textContent = _timeAgo(patch.lastRun);
      }

      // Merge into node card_data
      const node = cfg.resolve(nodeId);
      if (!node) return;
      if (!node.card_data) node.card_data = {};
      if (patch.status) node.card_data.status = patch.status;
      if (patch.lastRun) node.card_data.lastRun = patch.lastRun;
      if (patch.error !== undefined) node.card_data.error = patch.error;
      if (patch.files !== undefined) node.card_data.files = Array.isArray(patch.files) ? patch.files : [];

      // Keep files count inline inside the files button in the header.
      const filesBtn = document.getElementById(info.uid + '-files-open');
      const fileCount = Array.isArray(node.card_data.files) ? node.card_data.files.length : 0;
      if (filesBtn) {
        filesBtn.title = fileCount > 0 ? ('Files (' + fileCount + ')') : 'Files';
        filesBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>' + (fileCount > 0 ? ('<span class="ms-1 small" aria-label="' + fileCount + ' files">' + fileCount + '</span>') : '');
      }

      // Remove legacy external count label if present from older renders.
      const filesCountEl = document.getElementById(info.uid + '-files-count');
      if (filesCountEl && filesCountEl.parentNode) filesCountEl.parentNode.removeChild(filesCountEl);

      // Update inference status bar (tick / hourglass) if card_data changed
      const infBar = info.container.querySelector('.lc-inference-bar');
      if (infBar) {
        const infData = node.card_data && node.card_data.llm_task_completion_inference;
        const done = !!(infData && infData.isTaskCompleted);
        const iconEl = infBar.querySelector('.lc-inference-icon');
        if (iconEl) {
          iconEl.title = done ? 'Task completed' : 'Awaiting inference';
          iconEl.style.color = done ? '#198754' : '#aaa';
          iconEl.innerHTML = done ? '&#x25CF;' : '&#x25CB;';
        }
      }

      if (node.card_data.status === 'error' && node.card_data.error) {
        info.resultEl.innerHTML = `<div class="text-danger small fw-semibold">Refresh failed</div><pre class="text-muted small mt-1" style="white-space:pre-wrap">${_esc(node.card_data.error)}</pre>`;
      } else {
        _runCompute(node).then(function () { _renderElements(node, info.resultEl); });
      }
    }

    // ===========================================================================
    // Lifecycle
    // ===========================================================================

    function destroy(nodeId) {
      const c = _cleanup[nodeId];
      if (c) {
        c.ac.abort();
        c.timers.forEach(t => clearTimeout(t));
        c.charts.forEach(ch => { try { ch.inst.destroy(); } catch (_) {} });
        if (c.unsubs) c.unsubs.forEach(u => u());
        delete _cleanup[nodeId];
      }
      delete _nodeEls[nodeId];
    }

    function destroyAll() {
      Object.keys(_cleanup).forEach(destroy);
    }

    // ===========================================================================
    // Chat
    // ===========================================================================

    function appendChatMessage(nodeId, role, text) {
      if (_chatModal.currentNodeId !== nodeId) return;
      _appendModalChatMessage(role, text, []);
    }

    function refreshOpenChatModal() {
      const nodeId = _chatModal.currentNodeId;
      if (!nodeId || !_chatModal.backdrop || !_chatModal.backdrop.classList.contains('lc-open')) return;
      _refreshModalChatHistory(nodeId).catch(function () {});
    }

    function onServerSseEvent() {
      const nodeId = _chatModal.currentNodeId;
      if (!nodeId || !_chatModal.backdrop || !_chatModal.backdrop.classList.contains('lc-open')) return;
      _clearPendingModalChatMessages();
      _refreshModalChatHistory(nodeId).catch(function () {});
    }

    // ===========================================================================
    // Element access
    // ===========================================================================

    function getElement(nodeId, elemId) {
      const info = _nodeEls[nodeId];
      return (info && info.elements && info.elements[elemId]) || null;
    }

    // ===========================================================================
    // Return engine
    // ===========================================================================

    return {
      render,
      update,
      destroy,
      destroyAll,
      notify,
      subscribe,
      appendChatMessage,
      refreshOpenChatModal,
      onServerSseEvent,
      openChatModal,
      openFilesModal,
      getElement,
      registerRenderer(name, fn) { _renderers[name] = fn; },
      renderers: _renderers,
    };
  }

  // ===========================================================================
  // Board — grid (board) and DAG (canvas) modes
  // ===========================================================================

  function Board(engine, containerEl, opts) {
    opts = opts || {};
    const mode = { current: opts.mode || 'board' };
    const devMode = { current: opts.devMode || false };
    const nodeList = [];
    const nodeMap = {};        // id → { node, colEl, bodyEl }
    const _positions = {};     // id → { x, y, w, h } for canvas mode
    const showNotes = opts.showNotes !== false;
    const showChat  = opts.showChat || false;
    const defaultCol = opts.defaultCol || 6;
    const boardPanelCfg = (opts.boardPanel && typeof opts.boardPanel === 'object') ? opts.boardPanel : null;

    // Board Panel state (right-side overlay drawer)
    let _bpOpen = false, _bpTab = 'chat', _bpMessages = [], _bpPollTimer = null;
    let _bpTriggerBtn = null, _bpBackdrop = null, _bpPanel = null;
    let _bpChatBody = null, _bpChatInput = null, _bpGraphBody = null;

    // Canvas config
    const co = opts.canvas || {};
    const cvs = {
      snap:     co.snap || 20,
      zoomMin:  (co.zoom && co.zoom.min) || 0.25,
      zoomMax:  (co.zoom && co.zoom.max) || 2,
      zoom:     (co.zoom && co.zoom.initial) || 1,
      edges:    co.edges !== false,
      minWidth: co.minWidth || 220,
      maxWidth: co.maxWidth || 450,
      defaultW: co.defaultW || 350,
      gapX:     co.gapX || 280,
      gapY:     co.gapY || 320,
      padX:     co.padX || 20,
      padY:     co.padY || 20,
      cardMaxH: co.cardMaxH || 300,
      panX: 0, panY: 0,
    };
    const ac = new AbortController();
    const signal = ac.signal;

    // DOM containers
    const root = document.createElement('div');
    root.className = 'lc-board';
    containerEl.appendChild(root);

    const gridEl = document.createElement('div');
    gridEl.className = 'row g-3 lc-board-grid';

    const canvasEl = document.createElement('div');
    canvasEl.className = 'lc-canvas';
    const canvasHeight = co.height || '600px';
    const canvasOverflow = co.overflow || 'auto';
    canvasEl.style.cssText = 'position:relative;overflow:' + canvasOverflow + ';width:100%;height:' + canvasHeight + ';';
    const canvasInner = document.createElement('div');
    canvasInner.className = 'lc-canvas-inner';
    canvasInner.style.cssText = 'position:absolute;top:0;left:0;transform-origin:0 0;';
    canvasEl.appendChild(canvasInner);

    // SVG overlay for edges
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('class', 'lc-canvas-edges');
    svgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="lc-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--bs-secondary,#6c757d)"/></marker>';
    svgEl.appendChild(defs);
    canvasInner.appendChild(svgEl);

    // Board/canvas CSS
    if (!document.getElementById('lc-board-css')) {
      const s = document.createElement('style');
      s.id = 'lc-board-css';
      s.textContent = `
        .lc-canvas-card { position:absolute; min-width:${cvs.minWidth}px; max-width:${cvs.maxWidth}px; cursor:grab; user-select:none; z-index:1; }
        .lc-canvas-card.lc-dragging { cursor:grabbing; z-index:10; box-shadow:0 8px 24px rgba(0,0,0,0.18)!important; }
        .lc-canvas-card .card-body { max-height:${cvs.cardMaxH}px; overflow:auto; }
        .lc-canvas-edges line { stroke:var(--bs-secondary,#6c757d); stroke-width:1.5; }
        .lc-source-node { position:absolute; cursor:grab; user-select:none; z-index:1; }
        .lc-source-node.lc-dragging { cursor:grabbing; z-index:10; }
      `;
      document.head.appendChild(s);
    }

    // ===========================================================================
    // Board Panel (right-side overlay drawer)
    // ===========================================================================
    function _initBoardPanel() {
      if (!document.getElementById('lc-bp-css')) {
        const s = document.createElement('style');
        s.id = 'lc-bp-css';
        s.textContent = [
          '.lc-bp-trigger{position:fixed;top:14px;right:16px;z-index:9100;}',
          '.lc-bp-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9200;display:none;}',
          '.lc-bp-backdrop.lc-bp-open{display:block;}',
          '.lc-bp-panel{position:fixed;top:0;right:0;bottom:0;width:360px;max-width:96vw;z-index:9201;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,.15);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .22s ease;}',
          '.lc-bp-panel.lc-bp-open{transform:translateX(0);}',
          '.lc-bp-tabs{display:flex;border-bottom:1px solid var(--bs-border-color,#dee2e6);padding:0 .75rem;flex-shrink:0;}',
          '.lc-bp-tab-btn{background:none;border:none;border-bottom:2px solid transparent;padding:.45rem .75rem;font-size:.8rem;cursor:pointer;color:var(--bs-secondary,#6c757d);}',
          '.lc-bp-tab-btn.lc-bp-active{border-bottom-color:var(--bs-primary,#0d6efd);color:var(--bs-primary,#0d6efd);font-weight:600;}',
          '.lc-bp-pane{display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0;}',
          '.lc-bp-pane.lc-bp-active{display:flex;}',
          '.lc-bp-chat-body{flex:1;overflow-y:auto;padding:.5rem .75rem;}',
          '.lc-bp-graph-body{flex:1;overflow-y:auto;padding:.5rem .75rem;font-size:.8rem;}',
          '.lc-bp-input{padding:.5rem .75rem;border-top:1px solid var(--bs-border-color,#dee2e6);background:#fff;flex-shrink:0;}',
          '.lc-bp-graph-row{padding:.3rem 0;border-bottom:1px solid var(--bs-border-color-translucent,rgba(0,0,0,.05));}',
          '.lc-bp-graph-row:last-child{border-bottom:none;}',
          '.lc-bp-chat-bbl{padding:.4rem .65rem;margin:.25rem 0;border-radius:.65rem;word-wrap:break-word;font-size:.82rem;line-height:1.4;}',
          '.lc-bp-chat-user{background:var(--bs-primary-bg-subtle,#cfe2ff);margin-left:auto;max-width:85%;}',
          '.lc-bp-chat-asst{background:var(--bs-light,#f8f9fa);max-width:85%;}',
          '.lc-bp-chat-sys{color:var(--bs-secondary,#6c757d);font-style:italic;text-align:center;font-size:.76rem;max-width:100%;}',
        ].join('');
        document.head.appendChild(s);
      }

      _bpTriggerBtn = document.createElement('button');
      _bpTriggerBtn.className = 'lc-bp-trigger btn btn-sm btn-outline-primary';
      _bpTriggerBtn.innerHTML = '&#9881; Board';
      _bpTriggerBtn.title = 'Open Board Panel';
      _bpTriggerBtn.addEventListener('click', _bpOpenPanel);
      document.body.appendChild(_bpTriggerBtn);

      _bpBackdrop = document.createElement('div');
      _bpBackdrop.className = 'lc-bp-backdrop';
      _bpBackdrop.addEventListener('click', _bpClose);
      document.body.appendChild(_bpBackdrop);

      _bpPanel = document.createElement('div');
      _bpPanel.className = 'lc-bp-panel';

      const hdr = document.createElement('div');
      hdr.className = 'd-flex align-items-center justify-content-between px-3 py-2 border-bottom flex-shrink-0';
      const hdrTitle = document.createElement('strong');
      hdrTitle.className = 'small';
      hdrTitle.textContent = 'Board Panel';
      const hdrClose = document.createElement('button');
      hdrClose.className = 'btn-close';
      hdrClose.style.cssText = 'font-size:.75rem;';
      hdrClose.title = 'Close';
      hdrClose.addEventListener('click', _bpClose);
      hdr.appendChild(hdrTitle);
      hdr.appendChild(hdrClose);
      _bpPanel.appendChild(hdr);

      const tabBar = document.createElement('div');
      tabBar.className = 'lc-bp-tabs';
      ['chat', 'graph'].forEach(function (tabId) {
        const btn = document.createElement('button');
        btn.className = 'lc-bp-tab-btn' + (tabId === _bpTab ? ' lc-bp-active' : '');
        btn.dataset.bpTab = tabId;
        btn.textContent = tabId === 'chat' ? 'Chat' : 'Graph';
        btn.addEventListener('click', function () { _bpSwitchTab(tabId); });
        tabBar.appendChild(btn);
      });
      _bpPanel.appendChild(tabBar);

      const chatPane = document.createElement('div');
      chatPane.className = 'lc-bp-pane' + (_bpTab === 'chat' ? ' lc-bp-active' : '');
      chatPane.dataset.bpPane = 'chat';
      _bpChatBody = document.createElement('div');
      _bpChatBody.className = 'lc-bp-chat-body';
      chatPane.appendChild(_bpChatBody);
      _bpPanel.appendChild(chatPane);

      const graphPane = document.createElement('div');
      graphPane.className = 'lc-bp-pane' + (_bpTab === 'graph' ? ' lc-bp-active' : '');
      graphPane.dataset.bpPane = 'graph';
      _bpGraphBody = document.createElement('div');
      _bpGraphBody.className = 'lc-bp-graph-body';
      graphPane.appendChild(_bpGraphBody);
      _bpPanel.appendChild(graphPane);

      _bpChatInput = document.createElement('div');
      _bpChatInput.className = 'lc-bp-input';
      _bpChatInput.style.display = _bpTab === 'chat' ? '' : 'none';
      const inputRow = document.createElement('div');
      inputRow.className = 'd-flex gap-1 align-items-end';
      const textarea = document.createElement('textarea');
      textarea.className = 'form-control form-control-sm flex-grow-1';
      textarea.placeholder = 'Message board agent\u2026';
      textarea.rows = 2;
      textarea.style.cssText = 'resize:none;overflow-y:hidden;';
      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn btn-sm btn-primary';
      sendBtn.textContent = 'Send';
      sendBtn.addEventListener('click', function () { _bpSend(textarea); });
      textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _bpSend(textarea); }
      });
      inputRow.appendChild(textarea);
      inputRow.appendChild(sendBtn);
      _bpChatInput.appendChild(inputRow);
      _bpPanel.appendChild(_bpChatInput);

      document.body.appendChild(_bpPanel);
    }

    function _bpOpenPanel() {
      if (!_bpPanel) return;
      _bpOpen = true;
      _bpBackdrop.classList.add('lc-bp-open');
      _bpPanel.classList.add('lc-bp-open');
      if (_bpTab === 'chat') _bpLoadMessages();
      else _bpRenderGraph();
      _bpStartPoll();
    }

    function _bpClose() {
      if (!_bpPanel) return;
      _bpOpen = false;
      _bpBackdrop.classList.remove('lc-bp-open');
      _bpPanel.classList.remove('lc-bp-open');
      _bpStopPoll();
    }

    function _bpSwitchTab(tab) {
      _bpTab = tab;
      if (_bpPanel) {
        _bpPanel.querySelectorAll('[data-bp-tab]').forEach(function (b) {
          b.classList.toggle('lc-bp-active', b.dataset.bpTab === tab);
        });
        _bpPanel.querySelectorAll('[data-bp-pane]').forEach(function (p) {
          p.classList.toggle('lc-bp-active', p.dataset.bpPane === tab);
        });
        if (_bpChatInput) _bpChatInput.style.display = tab === 'chat' ? '' : 'none';
      }
      if (tab === 'chat') _bpLoadMessages();
      else _bpRenderGraph();
    }

    async function _bpLoadMessages() {
      if (!boardPanelCfg || typeof boardPanelCfg.getBoardChatMessages !== 'function') return;
      try {
        const msgs = await boardPanelCfg.getBoardChatMessages();
        if (Array.isArray(msgs)) { _bpMessages = msgs; _bpRenderChat(); }
      } catch (e) {
        console.warn('[board-panel] load messages failed', e);
      }
    }

    function _bpRenderChat() {
      if (!_bpChatBody) return;
      if (!_bpMessages.length) {
        _bpChatBody.innerHTML = '<p class="text-muted text-center mt-4" style="font-size:.78rem">No messages yet.<br>Ask the board agent something.</p>';
        return;
      }
      const atBottom = _bpChatBody.scrollHeight - _bpChatBody.scrollTop - _bpChatBody.clientHeight < 60;
      _bpChatBody.innerHTML = _bpMessages.map(function (m) {
        const role = String((m && m.role) || 'system');
        const cls = role === 'user' ? 'lc-bp-chat-user' : role === 'assistant' ? 'lc-bp-chat-asst' : 'lc-bp-chat-sys';
        return '<div class="lc-bp-chat-bbl ' + cls + '">' + _esc(String((m && m.text) || '')) + '</div>';
      }).join('');
      if (atBottom) _bpChatBody.scrollTop = _bpChatBody.scrollHeight;
    }

    function _bpRenderGraph() {
      if (!_bpGraphBody) return;
      if (!nodeList.length) {
        _bpGraphBody.innerHTML = '<p class="text-muted text-center mt-4" style="font-size:.78rem">No cards on this board.</p>';
        return;
      }
      _bpGraphBody.innerHTML = nodeList.map(function (node) {
        const card = node.card || {};
        const title = (card.meta && card.meta.title) || node.id;
        const status = (node.card_data && node.card_data.status) || '';
        const requires = Array.isArray(card.requires) && card.requires.length ? card.requires.join(', ') : '';
        const provides = Array.isArray(card.provides) && card.provides.length
          ? card.provides.map(function (p) { return p && p.bindTo; }).filter(Boolean).join(', ')
          : '';
        return '<div class="lc-bp-graph-row">'
          + '<div class="d-flex align-items-center gap-1 flex-wrap">'
          + (status ? _statusDot(status) : '')
          + '<strong style="font-size:.8rem">' + _esc(title) + '</strong>'
          + '<code class="text-muted ms-1" style="font-size:.72rem">' + _esc(node.id) + '</code>'
          + '</div>'
          + (requires ? '<div class="text-muted" style="font-size:.75rem">\u2190 ' + _esc(requires) + '</div>' : '')
          + (provides ? '<div class="text-muted" style="font-size:.75rem">\u2192 ' + _esc(provides) + '</div>' : '')
          + '</div>';
      }).join('');
    }

    async function _bpSend(textarea) {
      const text = (textarea && textarea.value || '').trim();
      if (!text || !boardPanelCfg || typeof boardPanelCfg.onBoardChatSend !== 'function') return;
      textarea.value = '';
      _bpMessages = _bpMessages.concat([{ role: 'user', text }]);
      _bpRenderChat();
      try {
        await boardPanelCfg.onBoardChatSend(text);
        await _bpLoadMessages();
      } catch (e) {
        console.warn('[board-panel] send failed', e);
      }
    }

    function _bpStartPoll() {
      _bpStopPoll();
      if (!boardPanelCfg) return;
      _bpPollTimer = setInterval(function () {
        if (!_bpOpen || _bpTab !== 'chat') return;
        _bpLoadMessages();
      }, 2000);
    }

    function _bpStopPoll() {
      if (_bpPollTimer) { clearInterval(_bpPollTimer); _bpPollTimer = null; }
    }

    function _bpDestroy() {
      _bpStopPoll();
      if (_bpTriggerBtn && _bpTriggerBtn.parentNode) _bpTriggerBtn.parentNode.removeChild(_bpTriggerBtn);
      if (_bpBackdrop && _bpBackdrop.parentNode) _bpBackdrop.parentNode.removeChild(_bpBackdrop);
      if (_bpPanel && _bpPanel.parentNode) _bpPanel.parentNode.removeChild(_bpPanel);
      _bpTriggerBtn = null; _bpBackdrop = null; _bpPanel = null;
    }

    if (boardPanelCfg) _initBoardPanel();

    // ---- Helpers ----

    function _colWidth(node) {
      const view = node && node.card ? node.card.view : null;
      if (view && view.layout && view.layout.board && view.layout.board.col) return view.layout.board.col;
      return defaultCol;
    }

    function _initPositions() {
      const explicit = opts.positions || {};
      nodeList.forEach((node, i) => {
        if (_positions[node.id]) return; // already set
        if (explicit[node.id]) {
          _positions[node.id] = Object.assign({}, explicit[node.id]);
        } else if (node.card && node.card.view && node.card.view.layout && node.card.view.layout.canvas && node.card.view.layout.canvas.x != null) {
          _positions[node.id] = Object.assign({}, node.card.view.layout.canvas);
        } else {
          const col = (i % 4);
          const row = Math.floor(i / 4);
          _positions[node.id] = { x: col * cvs.gapX + cvs.padX, y: row * cvs.gapY + cvs.padY, w: cvs.defaultW };
        }
      });
    }

    function _getRequires(node) {
      return (node && node.card && Array.isArray(node.card.requires)) ? node.card.requires : [];
    }

    function _showCardInspector(node) {
      const modal = document.createElement('div');
      modal.className = 'modal d-block';
      modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center;';

      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog';
      dialog.style.cssText = 'width: 92%; max-width: 980px; max-height: 88vh; overflow: auto;';

      const content = document.createElement('div');
      content.className = 'modal-content';

      const header = document.createElement('div');
      header.className = 'modal-header';
      header.innerHTML = `<h5 class="modal-title">Card Inspector: ${_esc((node.card && node.card.meta && node.card.meta.title) || node.id)}</h5><button type="button" class="btn-close" aria-label="Close"></button>`;

      const closeModal = function () { modal.remove(); };
      header.querySelector('.btn-close').addEventListener('click', closeModal);

      const body = document.createElement('div');
      body.className = 'modal-body';
      body.style.cssText = 'max-height: 64vh; overflow-y: auto;';

      const cardSection = document.createElement('div');
      cardSection.className = 'mb-4';
      cardSection.innerHTML = '<h6 class="fw-semibold mb-2">Card Object (Editable)</h6>';

      const editableCardObject = JSON.parse(JSON.stringify((node && node.card) ? node.card : {}));

      const editor = document.createElement('textarea');
      editor.className = 'form-control form-control-sm font-monospace';
      editor.rows = 16;
      editor.style.whiteSpace = 'pre';
      editor.value = JSON.stringify(editableCardObject, null, 2);

      const editorHint = document.createElement('div');
      editorHint.className = 'small text-muted mt-2';
      editorHint.textContent = 'Edit JSON and click Submit to apply updates to this card.';

      const editorError = document.createElement('div');
      editorError.className = 'small text-danger mt-1 d-none';

      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'btn btn-primary btn-sm mb-2';
      submitBtn.textContent = 'Submit';

      cardSection.appendChild(submitBtn);
      cardSection.appendChild(editor);
      cardSection.appendChild(editorHint);
      cardSection.appendChild(editorError);
      body.appendChild(cardSection);

      const computedSection = document.createElement('div');
      computedSection.className = 'mb-4';
      computedSection.innerHTML = '<h6 class="fw-semibold mb-2">Computed Values (Read-only)</h6>';
      const computedValues = node.computed_values || {};
      computedSection.innerHTML += `<pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-wrap: break-word;">${_esc(JSON.stringify(computedValues, null, 2))}</pre>`;
      body.appendChild(computedSection);

      const sourcesSection = document.createElement('div');
      sourcesSection.className = 'mb-4';
      sourcesSection.innerHTML = '<h6 class="fw-semibold mb-2">Fetched Sources (Read-only)</h6>';
      const sourcesData = node.fetched_sources || {};
      sourcesSection.innerHTML += `<pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-wrap: break-word;">${_esc(JSON.stringify(sourcesData, null, 2))}</pre>`;
      body.appendChild(sourcesSection);

      const requiresSection = document.createElement('div');
      requiresSection.className = 'mb-4';
      requiresSection.innerHTML = '<h6 class="fw-semibold mb-2">Requires (Read-only)</h6>';
      const requiresData = node.requires || {};
      requiresSection.innerHTML += `<pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-wrap: break-word;">${_esc(JSON.stringify(requiresData, null, 2))}</pre>`;
      body.appendChild(requiresSection);

      const stateSection = document.createElement('div');
      stateSection.className = 'mb-2';
      stateSection.innerHTML = '<h6 class="fw-semibold mb-2">Runtime Status (Read-only)</h6>';
      const runtimeState = { status: node.card_data && node.card_data.status, lastRun: node.card_data && node.card_data.lastRun, error: node.card_data && node.card_data.error };
      stateSection.innerHTML += `<pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-wrap: break-word;">${_esc(JSON.stringify(runtimeState, null, 2))}</pre>`;
      body.appendChild(stateSection);

      const footer = document.createElement('div');
      footer.className = 'modal-footer';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'btn btn-secondary';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', closeModal);

      submitBtn.addEventListener('click', function () {
        editorError.classList.add('d-none');
        editorError.textContent = '';
        try {
          const parsed = JSON.parse(editor.value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Card Object must be a JSON object.');
          }
          if (parsed.id && parsed.id !== node.id) {
            throw new Error('Changing card id is not supported in the inspector.');
          }

          const fixedId = node.id;
          const preservedRuntime = {
            card_data: node.card_data,
            fetched_sources: node.fetched_sources,
            requires: node.requires,
            computed_values: node.computed_values,
            runtime_state: node.runtime_state,
            data_objects: node.data_objects,
          };
          node.card = parsed;
          node.id = fixedId;
          Object.assign(node, preservedRuntime);

          engine.notify(node.id, { inspector: 'card-object-updated' });
          _render();

          submitBtn.textContent = '✓ Saved';
          setTimeout(function () { submitBtn.textContent = 'Submit'; }, 1200);
          closeModal();
        } catch (err) {
          editorError.textContent = 'Invalid JSON: ' + String((err && err.message) || err);
          editorError.classList.remove('d-none');
        }
      });

      footer.appendChild(closeBtn);
      content.appendChild(header);
      content.appendChild(body);
      content.appendChild(footer);
      dialog.appendChild(content);
      modal.appendChild(dialog);
      document.body.appendChild(modal);
    }

    function _buildCardWrapper(node) {
      const wrap = document.createElement('div');
      wrap.className = 'card shadow-sm h-100';
      const header = document.createElement('div');
      header.className = 'card-header d-flex align-items-center gap-2 py-2';
      const card = node && node.card ? node.card : {};
      const title = (card.meta && card.meta.title) || node.id;
      const tags = (card.meta && card.meta.tags) || [];
      let badgeHtml = '';
      if ((card.sources && card.sources.length) && !card.view) {
        var src = card.sources[0] || {};
        badgeHtml = '<span class="badge bg-info text-dark ms-auto">' + _esc(src.kind || 'source') + '</span>';
      } else if (tags.length) {
        badgeHtml = tags.map(t => '<span class="badge bg-secondary ms-1">' + _esc(t) + '</span>').join('');
      }
      header.innerHTML = '<strong class="small">' + _esc(title) + '</strong>' + badgeHtml;
      
      // Add dev mode code icon button if devMode is enabled
      if (devMode.current) {
        const codeBtn = document.createElement('button');
        codeBtn.className = 'btn btn-sm btn-outline-secondary';
        codeBtn.style.cssText = 'padding: 2px 6px; margin-left: auto;';
        codeBtn.innerHTML = '&lt;/&gt;';
        codeBtn.title = 'Inspect card data';
        codeBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          _showCardInspector(node);
        });
        header.appendChild(codeBtn);
      }
      
      const body = document.createElement('div');
      body.className = 'card-body p-2';
      wrap.appendChild(header);
      wrap.appendChild(body);
      return { wrap, header, body };
    }

    function _buildSourcePill(node) {
      const el = document.createElement('div');
      el.className = 'lc-source-node';
      const status = (node.card_data && node.card_data.status) || 'fresh';
      const card = node && node.card ? node.card : {};
      const title = (card.meta && card.meta.title) || node.id;
      const kind = (card.sources && card.sources[0] && card.sources[0].kind) || 'source';
      el.innerHTML = `<div class="lc-source-pill shadow-sm">
        ${_statusDot(status)}
        <span class="fw-medium">${_esc(title)}</span>
        <span class="badge bg-info text-dark">${_esc(kind)}</span>
      </div>`;
      return el;
    }

    // ---- Board mode ----

    function _renderBoard() {
      root.innerHTML = '';
      root.appendChild(gridEl);
      gridEl.innerHTML = '';

      // Only card nodes in board mode, sorted by order
      const cards = nodeList.filter(n => n.card && n.card.view).slice();
      cards.sort((a, b) => {
        const ao = (a.card && a.card.view && a.card.view.layout && a.card.view.layout.board && a.card.view.layout.board.order) || 0;
        const bo = (b.card && b.card.view && b.card.view.layout && b.card.view.layout.board && b.card.view.layout.board.order) || 0;
        return ao - bo;
      });

      cards.forEach(node => {
        const col = document.createElement('div');
        col.className = 'col-12 col-md-' + _colWidth(node);
        col.dataset.nodeId = node.id;
        const { wrap, body } = _buildCardWrapper(node);
        col.appendChild(wrap);
        gridEl.appendChild(col);
        nodeMap[node.id] = { node, colEl: col, bodyEl: body };
        engine.render(node, body, { showNotes, showChat });
      });
    }

    // ---- Canvas mode ----

    function _applyTransform() {
      canvasInner.style.transform = `translate(${cvs.panX}px,${cvs.panY}px) scale(${cvs.zoom})`;
    }

    function _drawEdges() {
      svgEl.querySelectorAll('line').forEach(l => l.remove());
      if (!cvs.edges) return;

      nodeList.forEach(node => {
        _getRequires(node).forEach(srcId => {
          const srcInfo = nodeMap[srcId];
          const tgtInfo = nodeMap[node.id];
          if (!srcInfo || !tgtInfo) return;
          const sEl = srcInfo.colEl;
          const tEl = tgtInfo.colEl;
          const sx = sEl.offsetLeft + sEl.offsetWidth;
          const sy = sEl.offsetTop + sEl.offsetHeight / 2;
          const tx = tEl.offsetLeft;
          const ty = tEl.offsetTop + tEl.offsetHeight / 2;
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', sx); line.setAttribute('y1', sy);
          line.setAttribute('x2', tx); line.setAttribute('y2', ty);
          line.setAttribute('marker-end', 'url(#lc-arrow)');
          svgEl.appendChild(line);
        });
      });
    }

    function _makeDraggable(el, node) {
      let startX, startY, origX, origY, dragging = false;

      el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('input,textarea,select,button,a,.form-check-input')) return;
        dragging = true;
        el.classList.add('lc-dragging');
        el.setPointerCapture(e.pointerId);
        startX = e.clientX; startY = e.clientY;
        origX = el.offsetLeft; origY = el.offsetTop;
        e.preventDefault();
      }, { signal });

      el.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = (e.clientX - startX) / cvs.zoom;
        const dy = (e.clientY - startY) / cvs.zoom;
        el.style.left = (origX + dx) + 'px';
        el.style.top  = (origY + dy) + 'px';
        _drawEdges();
      }, { signal });

      el.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('lc-dragging');
        let x = el.offsetLeft, y = el.offsetTop;
        if (cvs.snap > 1) { x = Math.round(x / cvs.snap) * cvs.snap; y = Math.round(y / cvs.snap) * cvs.snap; }
        el.style.left = x + 'px'; el.style.top = y + 'px';
        // Persist
        _positions[node.id] = Object.assign(_positions[node.id] || {}, { x, y });
        if (node.card && node.card.view) {
          if (!node.card.view.layout) node.card.view.layout = {};
          if (!node.card.view.layout.canvas) node.card.view.layout.canvas = {};
          node.card.view.layout.canvas.x = x;
          node.card.view.layout.canvas.y = y;
        }
        engine.notify(node.id);
        _drawEdges();
      }, { signal });
    }

    function _renderCanvas() {
      root.innerHTML = '';
      root.appendChild(canvasEl);
      canvasInner.querySelectorAll('.lc-canvas-card,.lc-source-node').forEach(el => el.remove());
      svgEl.querySelectorAll('line').forEach(l => l.remove());
      _initPositions();
      _applyTransform();

      nodeList.forEach(node => {
        const pos = _positions[node.id] || { x: 0, y: 0 };

        if ((!node.card || !node.card.view) && (node.card && node.card.sources && node.card.sources.length)) {
          const el = _buildSourcePill(node);
          el.dataset.nodeId = node.id;
          el.style.left = pos.x + 'px';
          el.style.top  = pos.y + 'px';
          canvasInner.appendChild(el);
          nodeMap[node.id] = { node, colEl: el, bodyEl: null };
          _makeDraggable(el, node);
        } else {
          const el = document.createElement('div');
          el.className = 'lc-canvas-card card shadow-sm';
          el.dataset.nodeId = node.id;
          el.style.left = pos.x + 'px';
          el.style.top  = pos.y + 'px';
          if (pos.w) el.style.width = pos.w + 'px';

          const { wrap, body } = _buildCardWrapper(node);
          while (wrap.firstChild) el.appendChild(wrap.firstChild);
          canvasInner.appendChild(el);
          nodeMap[node.id] = { node, colEl: el, bodyEl: body };
          engine.render(node, body, { showNotes: false, showChat: false });
          _makeDraggable(el, node);
        }
      });

      _drawEdges();

      // Pan: middle-click or Ctrl+drag on background
      let panning = false, panStartX, panStartY, panOrigX, panOrigY;
      canvasEl.addEventListener('pointerdown', e => {
        if (e.target !== canvasEl && e.target !== canvasInner) return;
        if (e.button === 1 || (e.button === 0 && e.ctrlKey)) {
          panning = true; canvasEl.setPointerCapture(e.pointerId);
          panStartX = e.clientX; panStartY = e.clientY;
          panOrigX = cvs.panX; panOrigY = cvs.panY;
          e.preventDefault();
        }
      }, { signal });
      canvasEl.addEventListener('pointermove', e => {
        if (!panning) return;
        cvs.panX = panOrigX + (e.clientX - panStartX);
        cvs.panY = panOrigY + (e.clientY - panStartY);
        _applyTransform();
      }, { signal });
      canvasEl.addEventListener('pointerup', () => { panning = false; }, { signal });

      // Zoom: Ctrl+wheel
      canvasEl.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        cvs.zoom = Math.min(cvs.zoomMax, Math.max(cvs.zoomMin, cvs.zoom * delta));
        _applyTransform();
      }, { signal, passive: false });
    }

    function _render() {
      if (mode.current === 'canvas') _renderCanvas();
      else _renderBoard();
      if (_bpOpen && _bpTab === 'graph') _bpRenderGraph();
    }

    // ---- Auto-layout (topological L → R) ----

    function autoLayout() {
      const incoming = {};
      const levels = {};
      nodeList.forEach(n => { incoming[n.id] = []; levels[n.id] = 0; });
      nodeList.forEach(n => {
        _getRequires(n).forEach(srcId => {
          if (incoming[n.id]) incoming[n.id].push(srcId);
        });
      });

      let changed = true;
      while (changed) {
        changed = false;
        nodeList.forEach(n => {
          (incoming[n.id] || []).forEach(srcId => {
            if (levels[srcId] != null && levels[srcId] + 1 > levels[n.id]) {
              levels[n.id] = levels[srcId] + 1;
              changed = true;
            }
          });
        });
      }

      const colCounts = {};
      nodeList.forEach(n => {
        const lv = levels[n.id] || 0;
        if (!colCounts[lv]) colCounts[lv] = 0;
        const row = colCounts[lv]++;
        _positions[n.id] = {
          x: lv * 400 + 40,
          y: row * 300 + 40,
          w: (_positions[n.id] && _positions[n.id].w) || cvs.defaultW,
        };
        // Sync to card nodes
        if (n.view) {
          if (!n.view.layout) n.view.layout = {};
          n.view.layout.canvas = Object.assign({}, _positions[n.id]);
        }
      });
      if (mode.current === 'canvas') _renderCanvas();
    }

    // ---- Public API ----

    function add(node) {
      if (nodeMap[node.id]) return;
      nodeList.push(node);
      _render();
    }

    function remove(nodeId) {
      engine.destroy(nodeId);
      const idx = nodeList.findIndex(n => n.id === nodeId);
      if (idx >= 0) nodeList.splice(idx, 1);
      delete nodeMap[nodeId];
      delete _positions[nodeId];
      _render();
    }

    function reorder(ids) {
      nodeList.length = 0;
      ids.forEach(id => {
        const info = nodeMap[id];
        if (info) nodeList.push(info.node);
      });
      _render();
    }

    function refresh() { _render(); }

    function clear() {
      engine.destroyAll();
      nodeList.length = 0;
      Object.keys(nodeMap).forEach(k => delete nodeMap[k]);
      Object.keys(_positions).forEach(k => delete _positions[k]);
      root.innerHTML = '';
    }

    function setMode(m) {
      if (m !== 'board' && m !== 'canvas') return;
      mode.current = m;
      _render();
    }

    function setDevMode(flag) {
      devMode.current = !!flag;
      _render();
    }

    function destroy() {
      _bpDestroy();
      ac.abort();
      engine.destroyAll();
      nodeList.length = 0;
      Object.keys(nodeMap).forEach(k => delete nodeMap[k]);
      root.innerHTML = '';
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    // ---- Init ----
    if (opts.nodes && opts.nodes.length) {
      opts.nodes.forEach(n => nodeList.push(n));
    }
    _render();

    return {
      add,
      remove,
      reorder,
      refresh,
      clear,
      setMode,
      setDevMode,
      autoLayout,
      destroy,
      get mode() { return mode.current; },
      get devMode() { return devMode.current; },
      get nodes() { return nodeList.slice(); },
      get engine() { return engine; },
    };
  }

  // ===========================================================================
  // Module export
  // ===========================================================================

  return { init, Board };
})();
