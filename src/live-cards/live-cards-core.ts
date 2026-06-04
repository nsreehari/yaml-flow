// @ts-nocheck
// live-cards.js — LiveCards v3: Node-based Board/Canvas engine
//
// Schema: Each node has { id } required; all else optional.
//   id, meta, card_data, requires, provides, view
//   Nodes with view render as cards; nodes with no view but with source_defs declared on the
//   underlying card definition render as source pills in canvas mode (source_defs are runtime-only;
//   they are not interpreted here).
//   requires[] — upstream provider tokens; engine subscribes automatically
//   provides[] — [{ bindTo, src }] explicit downstream token bindings
//   computed_values — derived values produced by the runtime; rendered as-is, never recomputed here
//
// Rendering contract: this module renders derived state only. View bind paths resolve to one of
//   card_data | requires | computed_values | runtime_state. Raw fetched-source payloads stay in the
//   runtime and never reach the Board.
//
// Uses Bootstrap 5 for layout/forms, optional Chart.js for charts.
//
// API:
//   const engine = LiveCard.init({ resolve, onPatch, onPatchState, onRefresh, onAction, markdown, sanitize, chartLib });
//   engine.render(node, el, opts?)     — render a card node into a DOM element
//   engine.update(nodeId, patch)       — in-place update (status, re-render)
//   engine.destroy(nodeId)             — tear down one node
//   engine.destroyAll()                — tear down all
//   engine.notify(nodeId, data?)       — signal change → downstream recompute
//   engine.subscribe(nodeId, cb)       — listen for changes; returns unsub fn
//   engine.appendChatMessage(nodeId, role, text)
//   engine.registerRenderer(name, fn)
//   LiveCard.registerCardRenderer(name, renderer)
//   LiveCard.registerBoardTheme(name, theme)
//   LiveCard.registerBoardRenderer(name, renderer)
//
//   Reactive board (preferred): state in, view out. No destructive re-renders.
//   const board = LiveCard.Board(engine, el, {
//     initialState, getNodeIds, selectNode,
//     mode?, canvas?, boardTheme?, boardRenderer?, boardSkin?,
//     boardClass?, listClass?, styles?
//   });
//   board.setState(nextState)          — diff vs prev; per-node updates only
//   board.destroy()
//
//   Imperative core (advanced): direct node-list manipulation.
//   const core = LiveCard.BoardCore(engine, el, {
//     nodes, positions?, mode, canvas?,
//     boardTheme?, boardRenderer?, boardSkin?,
//     boardClass?, listClass?, styles?
//   });
//   core.add(node), core.remove(id), core.reorder(ids), core.updateNode(id, model)
//   core.setMode('board'|'canvas'), core.setDevMode(flag), core.autoLayout(), core.clear(), core.destroy()

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
      .lc-chat-bubble { padding:.5rem .75rem; margin:.375rem 0; border-radius:.75rem; max-width:85%; word-wrap:break-word; font-size:.875rem; line-height:1.4; display:flex; gap:.5rem; align-items:flex-start; }
      .lc-chat-bubble-user { background:var(--bs-primary-bg-subtle,#cfe2ff); margin-left:auto; flex-direction:row-reverse; }
      .lc-chat-bubble-assistant { background:var(--bs-light,#f8f9fa); border:1px solid var(--bs-border-color,#dee2e6); }
      .lc-chat-bubble-system { background:transparent; color:var(--bs-secondary,#6c757d); font-style:italic; text-align:center; max-width:100%; font-size:.8rem; align-self:center; gap:0; padding:.125rem .5rem; }
      .lc-chat-icon { flex-shrink:0; line-height:1.4; opacity:.6; display:flex; align-items:center; margin-top:.15rem; }
      .lc-chat-bubble-content { flex:1; min-width:0; }
      .lc-chat-bubble-content p:last-child { margin-bottom:0; }
      .lc-chat-bubble-pending { opacity:.85; }
      .lc-chat-bubble-pending .spinner-border { width:.75rem; height:.75rem; margin-left:.4rem; border-width:.12em; vertical-align:middle; }
      .lc-chat-processing { display:flex; align-items:center; gap:.5rem; padding:.375rem .75rem; color:var(--bs-secondary,#6c757d); font-size:.8rem; font-style:italic; }
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
      .lc-simulation-card { background:#fdf6ec; border-color:#e0c97f !important; }
      .lc-simulation-card .card-header { background:#faecc8; border-bottom-color:#e0c97f; }
      .lc-gandalf-card { background:#eef4ff; border-color:#6ea4e0 !important; }
      .lc-gandalf-card .card-header { background:#d7e8fa; border-bottom-color:#6ea4e0; cursor:pointer; user-select:none; }
      .lc-gandalf-card .card-header:hover { background:#c8dcf5; }
      .lc-gandalf-caret { transition:transform .2s; display:inline-flex; align-items:center; margin-left:auto; opacity:.6; flex-shrink:0; cursor:pointer; padding:2px; }
      .lc-gandalf-caret:hover { opacity:1; }
      .lc-gandalf-card.lc-collapsed .lc-gandalf-caret { transform:rotate(-90deg); }
      .lc-gandalf-card.lc-collapsed .card-body { display:none !important; }
      .lc-token-row { display:flex; flex-wrap:wrap; gap:0.35rem; padding:0.2rem 0.5rem; background:transparent; align-items:center; justify-content:center; min-height:0; }
      .lc-token-row-requires { border-bottom:none; padding-bottom:0.1rem; }
      .lc-token-row-provides { border-top:none; padding-top:0.1rem; }
      .lc-token-gem { display:inline-block; width:10px; height:10px; border-radius:50%; cursor:default; transition:transform .15s, box-shadow .15s; position:relative; }
      .lc-token-gem:hover { transform:scale(1.5); box-shadow:0 0 4px rgba(0,0,0,0.3); z-index:5; }
      .lc-token-gem-requires { background:var(--bs-secondary,#6c757d); border:1.5px solid var(--bs-secondary,#6c757d); }
      .lc-token-gem-requires.lc-token-available { background:var(--bs-success,#198754); border-color:var(--bs-success,#198754); }
      .lc-token-gem-provides { background:var(--bs-secondary,#6c757d); border:1.5px solid var(--bs-secondary,#6c757d); }
      .lc-token-gem-provides.lc-token-available { background:var(--bs-success,#198754); border-color:var(--bs-success,#198754); }
      .lc-running { animation:lc-running-pulse 2s ease-in-out infinite; position:relative; }
      .lc-running::before { content:''; position:absolute; inset:-2px; border-radius:inherit; background:linear-gradient(90deg,transparent,rgba(13,110,253,.45),rgba(102,16,242,.4),rgba(13,110,253,.45),transparent); background-size:300% 100%; animation:lc-running-shimmer 2s linear infinite; z-index:-1; pointer-events:none; }
      @keyframes lc-running-pulse { 0%,100%{ box-shadow:0 0 4px rgba(13,110,253,.15); } 50%{ box-shadow:0 0 14px 3px rgba(13,110,253,.35); } }
      @keyframes lc-running-shimmer { 0%{ background-position:100% 0; } 100%{ background-position:-100% 0; } }
      .lc-running .card-header { border-bottom-color:rgba(13,110,253,.35); }
      @media (max-width:576px) {
        .lc-metric-value { font-size:1.5rem; }
        .lc-chart-wrap { min-height:150px; }
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

  // ===========================================================================
  // Global card renderer registry
  // Custom renderers registered here are available to all Board instances.
  // ===========================================================================

  const _globalRenderers = {};
  const _globalBoardThemes = {};
  const _globalBoardRenderers = {};

  function registerCardRenderer(name, renderer) {
    if (!name || typeof name !== 'string') throw new Error('registerCardRenderer: name is required');
    if (!renderer || typeof renderer !== 'object') throw new Error('registerCardRenderer: renderer must be an object');
    _globalRenderers[name] = renderer;
  }

  function registerBoardTheme(name, theme) {
    if (!name || typeof name !== 'string') throw new Error('registerBoardTheme: name is required');
    if (!theme || typeof theme !== 'object') throw new Error('registerBoardTheme: theme must be an object');
    _globalBoardThemes[name] = theme;
  }

  function registerBoardRenderer(name, renderer) {
    if (!name || typeof name !== 'string') throw new Error('registerBoardRenderer: name is required');
    if (!renderer || typeof renderer !== 'object') throw new Error('registerBoardRenderer: renderer must be an object');
    _globalBoardRenderers[name] = renderer;
  }

  function _resolveRegistryEntry(ref, registry) {
    if (!ref) return null;
    if (typeof ref === 'string') return registry[ref] || null;
    if (typeof ref === 'object') return ref;
    return null;
  }

  function _joinClasses() {
    return Array.prototype.slice.call(arguments)
      .filter(function(v) { return typeof v === 'string' && v.trim(); })
      .join(' ')
      .trim();
  }

  function _mergeStyleValue(base, incoming) {
    if (!incoming) return base || null;
    if (!base) {
      if (typeof incoming === 'string') return incoming;
      if (incoming && typeof incoming === 'object') return Object.assign({}, incoming);
      return null;
    }
    if (typeof base === 'string' || typeof incoming === 'string') {
      return [base, incoming].filter(function(v) { return typeof v === 'string' && v.trim(); }).join('; ');
    }
    if (base && typeof base === 'object' && incoming && typeof incoming === 'object') {
      return Object.assign({}, base, incoming);
    }
    return incoming || base || null;
  }

  function _mergeBoardPresentation() {
    const out = {
      boardClass: '',
      listClass: '',
      canvasClass: '',
      canvasInnerClass: '',
      styles: '',
      boardStyle: null,
      listStyle: null,
      canvasStyle: null,
      canvasInnerStyle: null,
    };
    Array.prototype.slice.call(arguments).forEach(function(item) {
      if (!item || typeof item !== 'object') return;
      out.boardClass = _joinClasses(out.boardClass, item.boardClass, item.rootClass);
      out.listClass = _joinClasses(out.listClass, item.listClass, item.gridClass);
      out.canvasClass = _joinClasses(out.canvasClass, item.canvasClass);
      out.canvasInnerClass = _joinClasses(out.canvasInnerClass, item.canvasInnerClass);
      if (typeof item.styles === 'string' && item.styles.trim()) {
        out.styles += (out.styles ? '\n' : '') + item.styles;
      }
      out.boardStyle = _mergeStyleValue(out.boardStyle, item.boardStyle || item.rootStyle);
      out.listStyle = _mergeStyleValue(out.listStyle, item.listStyle || item.gridStyle);
      out.canvasStyle = _mergeStyleValue(out.canvasStyle, item.canvasStyle);
      out.canvasInnerStyle = _mergeStyleValue(out.canvasInnerStyle, item.canvasInnerStyle);
    });
    return out;
  }

  function _applyElementPresentation(el, baseClass, extraClass, baseStyle, extraStyle) {
    el.className = _joinClasses(baseClass, extraClass);
    el.style.cssText = typeof baseStyle === 'string' ? baseStyle : '';
    if (typeof extraStyle === 'string' && extraStyle.trim()) {
      if (el.style.cssText && !/;\s*$/.test(el.style.cssText)) el.style.cssText += ';';
      el.style.cssText += extraStyle;
    } else if (extraStyle && typeof extraStyle === 'object') {
      Object.keys(extraStyle).forEach(function(key) {
        if (extraStyle[key] != null) el.style[key] = extraStyle[key];
      });
    }
  }

  function _isDomElement(value) {
    return !!(value && typeof value === 'object' && value.nodeType === 1);
  }

  function _hasBoardPresentation(presentation) {
    if (!presentation || typeof presentation !== 'object') return false;
    return !!(
      presentation.boardClass || presentation.listClass || presentation.canvasClass || presentation.canvasInnerClass ||
      presentation.styles || presentation.boardStyle || presentation.listStyle || presentation.canvasStyle || presentation.canvasInnerStyle
    );
  }

  function _boardPresentationFromCardRenderer(renderer) {
    if (!renderer || typeof renderer !== 'object') return null;
    const presentation = {
      boardClass: renderer.boardClass,
      listClass: renderer.listClass,
      canvasClass: renderer.canvasClass,
      canvasInnerClass: renderer.canvasInnerClass,
      styles: renderer.styles,
      boardStyle: renderer.boardStyle,
      listStyle: renderer.listStyle,
      canvasStyle: renderer.canvasStyle,
      canvasInnerStyle: renderer.canvasInnerStyle,
    };
    return _hasBoardPresentation(presentation) ? presentation : null;
  }

  function _deriveBoardPresentationFromNodes(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    for (let i = 0; i < list.length; i += 1) {
      const key = _rendererKey(list[i]);
      const renderer = key ? _globalRenderers[key] : null;
      const presentation = _boardPresentationFromCardRenderer(renderer);
      if (presentation) return presentation;
    }
    return null;
  }

  function _rendererKey(model) {
    const meta = model && model.card && model.card.meta;
    if (!meta) return null;
    return meta.cardRenderer || meta.card_renderer || null;
  }

  function _chatStateFromCardState(model) {
    const cc = model && model.card_chats;
    if (!cc || typeof cc !== 'object') return { messages: [], receiving: false, processing: false };
    const rawMessages = Array.isArray(cc.messages) ? cc.messages
      : Array.isArray(cc.items) ? cc.items // temporary tolerance
      : [];
    const messages = rawMessages.map(function (m) {
      if (!m || typeof m !== 'object') return null;
      return {
        role: typeof m.role === 'string' ? m.role.toLowerCase() : 'system',
        text: typeof m.text === 'string' ? m.text : (typeof m.message === 'string' ? m.message : ''),
        files: Array.isArray(m.files) ? m.files : [],
      };
    }).filter(Boolean);
    return { messages: messages, receiving: !!cc.receiving, processing: !!cc.processing };
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
      startReceivingChats:  config.startReceivingChats  || null,
      stopReceivingChats:   config.stopReceivingChats   || null,
      fileUrlBase:  config.fileUrlBase  || '/api/boards/default',
    };

    const _cleanup = {};    // nodeId → { ac, timers, charts, unsubs }
    const _subs = {};       // nodeId → Set<callback>
    const _etState = {};    // stateKey → { baseRows, journalRows|null }
    const _formState = {};  // stateKey → { baseValues, journal }
    const _notesState = {}; // stateKey → { baseContent, journal|null }
    const _todoState = {};  // stateKey → { currentState, pending } for todo dirty tracking

    /**
     * Overlay a "Saving…" spinner over `el` while a patch is in-flight.
     * The overlay is removed automatically on the next SSE re-render because
     * every editable renderer does `el.innerHTML = …` on refresh.
     */
    function _showSavingOverlay(el) {
      // Ensure the container is a positioned ancestor so the overlay can fill it.
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      const overlay = document.createElement('div');
      overlay.className = 'lc-saving-overlay';
      overlay.setAttribute('aria-live', 'polite');
      overlay.style.cssText = [
        'position:absolute', 'inset:0',
        'background:rgba(255,255,255,0.78)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'gap:0.5rem', 'z-index:20', 'border-radius:inherit',
        'pointer-events:all',   // blocks all clicks on underlying inputs
      ].join(';');
      overlay.innerHTML =
        '<span class="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true"></span>' +
        '<span class="text-primary fw-medium small">Saving…</span>';
      el.appendChild(overlay);
    }
    const _renderers = {}; // kind → fn
    const _nodeEls = {};   // nodeId → { container, resultEl, uid }

    // ---- Chat pane registry ----
    // All currently-mounted chat panes (modal + inline). SSE / refresh hooks
    // iterate this to update every visible pane bound to the affected card.
    const _chatPanes = new Set<any>();
    // The modal's pane (lazily created by _ensureChatModal). null when modal
    // has never been opened.
    let _modalPane: any = null;
    // Modal-only chrome references (backdrop / title / close button).
    const _chatModalRefs: any = { backdrop: null, title: null, closeBtn: null };

    // ---- Files pane registry ----
    // All currently-mounted file panes (modal + inline upload + inline list).
    // openFilesModal / destroyAll / SSE-equivalent refreshes iterate these.
    const _filesPanes = new Set<any>();
    // The modal's pane references (set by _ensureFilesModal). The modal
    // composes one upload pane + one list pane inside its dialog chrome.
    let _filesModalUploadPane: any = null;
    let _filesModalListPane: any = null;
    const _filesModalRefs: any = { backdrop: null, title: null, closeBtn: null, currentNodeId: null };

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

    // ---------------------------------------------------------------------------
    // Chat pane builder
    //
    // Builds a self-contained chat pane (bubbles area + input row) bound to a
    // card. Used by both the modal (which provides the dialog chrome) and by
    // the public mountChatPane() entry point (which renders the pane inline
    // inside a caller-owned container). The pane is the single source of
    // chat-UI truth — there is no separate inline implementation.
    //
    // spec: {
    //   bodyEl: HTMLElement,           // bubble container (cleared on refresh)
    //   inputRowEl: HTMLElement,       // input/staged container (cleared on build)
    //   cardId?: string | null,        // initial bound card
    //   isModal?: boolean,             // marks this pane as the modal pane
    //   options?: {
    //     placeholder?: string,
    //     showEmptyState?: boolean,
    //     fileAttach?: boolean,
    //     fileAccept?: string[],
    //     autoSubscribe?: boolean,     // start/stopReceivingChats on bind/dispose
    //   },
    // }
    // ---------------------------------------------------------------------------
    function _buildChatPane(spec: any) {
      const opts = Object.assign({
        placeholder: 'Type a message...',
        showEmptyState: true,
        fileAttach: true,
        fileAccept: null,
        autoSubscribe: true,
      }, (spec && spec.options) || {});

      const pane: any = {
        body: spec.bodyEl,
        inputRow: spec.inputRowEl,
        input: null,
        fileInput: null,
        staged: null,
        sendBtn: null,
        attachBtn: null,
        sendBtnIdleHtml: '',
        cardId: spec.cardId || null,
        stagedFiles: [],
        loading: false,
        awaitingProcessingAck: false,
        disposed: false,
        isModal: !!spec.isModal,
        options: opts,
      };

      // Build input row markup. Same DOM/classes the modal has always used so
      // the modal layout is byte-identical to before.
      const attachHtml = opts.fileAttach
        ? '<button type="button" class="btn btn-sm btn-outline-secondary" data-lc-chat-attach title="Attach files" aria-label="Attach files">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>' +
          '</button>'
        : '';
      pane.inputRow.innerHTML =
        '<div data-lc-chat-staged class="small w-100"></div>' +
        '<input type="file" class="d-none" data-lc-chat-file multiple>' +
        '<div class="lc-chat-modal-input-row mt-2">' +
          attachHtml +
          '<textarea class="form-control" data-lc-chat-input rows="1" placeholder="' + _esc(opts.placeholder) + '"></textarea>' +
          '<button type="button" class="btn btn-sm btn-primary" data-lc-chat-send aria-label="Send">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
          '</button>' +
        '</div>';
      pane.input = pane.inputRow.querySelector('[data-lc-chat-input]');
      pane.fileInput = pane.inputRow.querySelector('[data-lc-chat-file]');
      pane.staged = pane.inputRow.querySelector('[data-lc-chat-staged]');
      pane.sendBtn = pane.inputRow.querySelector('[data-lc-chat-send]');
      pane.attachBtn = pane.inputRow.querySelector('[data-lc-chat-attach]');
      pane.sendBtnIdleHtml = pane.sendBtn ? pane.sendBtn.innerHTML : '';
      if (opts.fileAccept && Array.isArray(opts.fileAccept) && pane.fileInput) {
        pane.fileInput.setAttribute('accept', opts.fileAccept.join(','));
      }

      function resizeInput() {
        if (!pane.input) return;
        pane.input.style.height = 'auto';
        pane.input.style.height = Math.min(pane.input.scrollHeight, 120) + 'px';
      }
      pane.resizeInput = resizeInput;

      pane.syncComposerState = function () {
        const node = pane.cardId ? cfg.resolve(pane.cardId) : null;
        const chatDisabled = !!(node && node.card_data && node.card_data.features && node.card_data.features.chat && node.card_data.features.chat.disabled);
        const isProcessing = !!_chatStateFromCardState(node).processing;
        if (pane.input) {
          pane.input.disabled = chatDisabled;
          pane.input.placeholder = chatDisabled ? 'Chat is disabled for this card.' : opts.placeholder;
        }
        if (pane.attachBtn) pane.attachBtn.disabled = chatDisabled || isProcessing;
        if (pane.sendBtn) pane.sendBtn.disabled = chatDisabled || isProcessing || !!pane.loading || !!pane.awaitingProcessingAck;
      };

      pane.setSendButtonPending = function (pending) {
        pane.awaitingProcessingAck = !!pending;
        if (!pane.sendBtn) { pane.syncComposerState(); return; }
        if (pending) {
          pane.sendBtn.setAttribute('aria-label', 'Waiting for AI response');
          pane.sendBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
        } else {
          pane.sendBtn.innerHTML = pane.sendBtnIdleHtml;
          pane.sendBtn.setAttribute('aria-label', 'Send');
        }
        pane.syncComposerState();
      };

      pane.appendMessage = function (role, text, files) {
        if (!pane.body) return;
        if (!text && !(Array.isArray(files) && files.length)) return;
        const normalizedRole = role === 'user' || role === 'assistant' ? role : 'system';
        const roleClass = normalizedRole === 'user'
          ? 'lc-chat-bubble-user'
          : (normalizedRole === 'assistant' ? 'lc-chat-bubble-assistant' : 'lc-chat-bubble-system');
        const bubble = document.createElement('div');
        bubble.className = 'lc-chat-bubble ' + roleClass;
        if (normalizedRole !== 'system') {
          const userSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>';
          const asstSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
          const iconEl = document.createElement('span');
          iconEl.className = 'lc-chat-icon';
          iconEl.setAttribute('aria-hidden', 'true');
          iconEl.innerHTML = normalizedRole === 'user' ? userSvg : asstSvg;
          bubble.appendChild(iconEl);
        }
        const content = document.createElement('div');
        content.className = 'lc-chat-bubble-content';
        if (normalizedRole === 'assistant') content.innerHTML = _renderMd(text || '');
        else content.textContent = text || '';
        if (Array.isArray(files) && files.length) {
          const meta = document.createElement('div');
          meta.className = 'small mt-1 text-muted';
          meta.textContent = '\uD83D\uDCCE ' + files.map(function (f) {
            if (!f) return 'file';
            return typeof f === 'string' ? f : (f.name || 'file');
          }).join(', ');
          content.appendChild(meta);
        }
        bubble.appendChild(content);
        pane.body.appendChild(bubble);
        pane.body.scrollTop = pane.body.scrollHeight;
      };

      pane.appendPending = function (text) {
        if (!pane.body) return;
        const bubble = document.createElement('div');
        bubble.className = 'lc-chat-bubble lc-chat-bubble-user lc-chat-bubble-pending';
        bubble.setAttribute('data-lc-chat-pending', '1');
        bubble.textContent = text || '';
        const spinner = document.createElement('span');
        spinner.className = 'spinner-border spinner-border-sm';
        spinner.setAttribute('role', 'status');
        spinner.setAttribute('aria-label', 'Sending');
        bubble.appendChild(spinner);
        pane.body.appendChild(bubble);
        pane.body.scrollTop = pane.body.scrollHeight;
      };

      pane.clearPending = function () {
        if (!pane.body) return;
        pane.body.querySelectorAll('[data-lc-chat-pending="1"]').forEach(function (el) {
          if (el && el.parentNode) el.parentNode.removeChild(el);
        });
      };

      pane.syncProcessingBar = function () {
        if (!pane.body) return;
        const node = pane.cardId ? cfg.resolve(pane.cardId) : null;
        const isProcessing = !!_chatStateFromCardState(node).processing;
        pane.syncComposerState();
        let ind = pane.body.querySelector('.lc-chat-processing');
        if (isProcessing) {
          if (!ind) {
            const workingSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
            ind = document.createElement('div');
            ind.className = 'lc-chat-processing';
            ind.innerHTML = '<span class="lc-chat-icon" aria-hidden="true">' + workingSvg + '</span><span>AI working\u2026</span><span class="spinner-border spinner-border-sm" role="status" aria-label="AI working"></span>';
            pane.body.appendChild(ind);
          }
          pane.body.scrollTop = pane.body.scrollHeight;
        } else {
          if (ind) ind.remove();
        }
      };

      pane.refresh = function () {
        if (!pane.body) return;
        if (!pane.cardId) {
          pane.body.innerHTML = '';
          pane.syncComposerState();
          return;
        }
        const node = cfg.resolve(pane.cardId);
        let messages = [];
        // State-driven: chat history comes from card_chats, populated by the runtime/client.
        if (node && node.card_chats) {
          messages = _chatStateFromCardState(node).messages;
        } else if (node && node.card_data && Array.isArray(node.card_data.messages)) {
          messages = node.card_data.messages;
        }
        const normalized = _normalizeChatMessages(messages);
        pane.body.innerHTML = '';
        if (!normalized.length) {
          if (opts.showEmptyState) {
            pane.body.innerHTML = '<div class="text-muted small">No messages yet.</div>';
          }
          pane.syncProcessingBar();
          return;
        }
        normalized.forEach(function (m) { pane.appendMessage(m.role, m.text, m.files); });
        pane.syncProcessingBar();
      };

      function renderStagedFiles() {
        if (!pane.staged) return;
        if (!pane.stagedFiles.length) { pane.staged.innerHTML = ''; return; }
        pane.staged.innerHTML = pane.stagedFiles.map(function (f, i) {
          return '<span class="badge text-bg-light border me-1 mb-1">' + _esc(f.name || 'file') +
            ' <button type="button" class="btn btn-sm btn-link text-danger p-0 ms-1" data-lc-rm-file="' + i + '">&times;</button></span>';
        }).join('');
        pane.staged.querySelectorAll('[data-lc-rm-file]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            const idx = parseInt(btn.getAttribute('data-lc-rm-file') || '-1', 10);
            if (idx >= 0) pane.stagedFiles.splice(idx, 1);
            renderStagedFiles();
          });
        });
      }
      pane.renderStagedFiles = renderStagedFiles;

      async function sendMessage() {
        if (pane.loading || !pane.cardId || pane.disposed) return;
        const nodeId = pane.cardId;
        const text = (pane.input.value || '').trim();
        const files = pane.stagedFiles.slice();
        if (!text && !files.length) return;
        if (files.length) {
          pane.appendMessage('system', 'Chat send does not support files. Upload attachments separately before sending.', []);
          return;
        }

        pane.loading = true;
        pane.syncComposerState();
        pane.setSendButtonPending(true);

        pane.appendPending(text);

        pane.input.value = '';
        pane.stagedFiles = [];
        resizeInput();
        renderStagedFiles();

        try {
          await Promise.resolve(cfg.onAction(nodeId, 'chat-send', { text }));
        } catch (err) {
          pane.setSendButtonPending(false);
          pane.clearPending();
          pane.appendMessage('system', 'Failed to send message: ' + String((err && err.message) || err), []);
        } finally {
          pane.loading = false;
          pane.syncComposerState();
        }
      }
      pane.sendMessage = sendMessage;

      // Wire events. The pane keeps a list of (target, type, handler) entries
      // and removes them on dispose so detaching an inline pane doesn't leak.
      const _listeners: Array<{ t: any; e: string; h: any }> = [];
      function on(target, evt, handler) {
        target.addEventListener(evt, handler);
        _listeners.push({ t: target, e: evt, h: handler });
      }

      if (pane.attachBtn && pane.fileInput) {
        on(pane.attachBtn, 'click', function () { pane.fileInput.click(); });
        on(pane.fileInput, 'change', function (evt) {
          const files = evt.target && evt.target.files ? Array.from(evt.target.files) : [];
          for (const f of files) {
            if (!pane.stagedFiles.find(function (x) { return x.name === (f as any).name && x.size === (f as any).size && x.lastModified === (f as any).lastModified; })) {
              pane.stagedFiles.push(f);
            }
          }
          evt.target.value = '';
          renderStagedFiles();
        });
      }
      on(pane.sendBtn, 'click', sendMessage);
      on(pane.input, 'input', resizeInput);
      on(pane.input, 'keydown', function (evt) {
        if (evt.key === 'Enter' && !evt.shiftKey) {
          if (pane.sendBtn && pane.sendBtn.disabled) return;
          evt.preventDefault();
          sendMessage();
        }
      });
      resizeInput();

      pane.dispose = function () {
        if (pane.disposed) return;
        pane.disposed = true;
        _listeners.forEach(function (l) {
          try { l.t.removeEventListener(l.e, l.h); } catch (e) { /* noop */ }
        });
        _listeners.length = 0;
        _chatPanes.delete(pane);
        if (opts.autoSubscribe && pane.cardId && typeof cfg.stopReceivingChats === 'function') {
          try { cfg.stopReceivingChats(pane.cardId); } catch (e) { /* noop */ }
        }
        pane.stagedFiles = [];
      };

      _chatPanes.add(pane);

      // Initial render + lifecycle hook for inline panes that have a cardId.
      pane.syncComposerState();
      if (pane.cardId && opts.autoSubscribe && typeof cfg.startReceivingChats === 'function') {
        try { cfg.startReceivingChats(pane.cardId); } catch (e) { /* noop */ }
      }
      if (pane.cardId) pane.refresh();

      return pane;
    }

    function _ensureChatModal() {
      if (_chatModalRefs.backdrop) return;

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
        '    <div class="modal-footer flex-column align-items-stretch border-top p-3 gap-3" data-lc-chat-footer></div>' +
        '  </div>' +
        '</div>';

      document.body.appendChild(backdrop);
      const bodyEl = backdrop.querySelector('[data-lc-chat-body]');
      const footerEl = backdrop.querySelector('[data-lc-chat-footer]');
      const titleEl = backdrop.querySelector('.lc-chat-modal-title');
      const closeBtn = backdrop.querySelector('[data-lc-chat-close]');

      _chatModalRefs.backdrop = backdrop;
      _chatModalRefs.title = titleEl;
      _chatModalRefs.closeBtn = closeBtn;

      // The modal owns its open/close chrome but delegates all chat behavior
      // (bubbles, send, processing indicator, pending bubble, disabled
      // handling, etc.) to a chat pane bound to its body+footer. autoSubscribe
      // is false because the modal manages start/stopReceivingChats explicitly
      // around its open/close lifecycle.
      _modalPane = _buildChatPane({
        bodyEl: bodyEl,
        inputRowEl: footerEl,
        cardId: null,
        isModal: true,
        options: { autoSubscribe: false },
      });

      const close = function () {
        const closingNodeId = _modalPane ? _modalPane.cardId : null;
        if (_modalPane) {
          _modalPane.cardId = null;
          _modalPane.stagedFiles = [];
          if (_modalPane.staged) _modalPane.staged.innerHTML = '';
          if (_modalPane.input) _modalPane.input.value = '';
          _modalPane.setSendButtonPending(false);
          _modalPane.resizeInput();
        }
        backdrop.classList.remove('lc-open');
        // Lifecycle hook: stop receiving chats
        if (closingNodeId && typeof cfg.stopReceivingChats === 'function') cfg.stopReceivingChats(closingNodeId);
      };

      closeBtn.addEventListener('click', close);
      backdrop.addEventListener('click', function (evt) {
        if (evt.target === backdrop) close();
      });
      document.addEventListener('keydown', function (evt) {
        if (evt.key === 'Escape' && backdrop.classList.contains('lc-open')) close();
      });
    }

    async function openChatModal(nodeId) {
      _ensureChatModal();
      const node = cfg.resolve(nodeId);
      if (!node) return;
      const title = (node.card && node.card.meta && node.card.meta.title) || node.id;
      _modalPane.cardId = nodeId;
      _chatModalRefs.title.textContent = 'Chat: ' + title;
      _modalPane.body.innerHTML = '<div class="text-muted small">Loading...</div>';
      _chatModalRefs.backdrop.classList.add('lc-open');

      _modalPane.syncComposerState();
      if (!_modalPane.input.disabled) _modalPane.input.focus();
      // Lifecycle hook: start receiving chats (drives state-driven refresh via onServerSseEvent)
      if (typeof cfg.startReceivingChats === 'function') cfg.startReceivingChats(nodeId);
      _modalPane.refresh();
    }

    // Public: mount a chat pane inside a caller-owned container. Returns a
    // handle the caller uses to refresh / dispose. Behavior is identical to
    // the modal's body+input row — same DOM/classes, same card_chats source
    // of truth, same chat-send action, same pending/ack lifecycle.
    function mountChatPane(options) {
      options = options || {};
      if (!options.container) throw new Error('mountChatPane: container is required');
      if (!options.cardId) throw new Error('mountChatPane: cardId is required');
      const container: HTMLElement = options.container;
      container.innerHTML = '';
      const bodyEl = document.createElement('div');
      bodyEl.className = 'lc-chat-pane-body modal-body bg-light';
      const inputRowEl = document.createElement('div');
      inputRowEl.className = 'lc-chat-pane-input modal-footer flex-column align-items-stretch border-top p-3 gap-3';
      container.appendChild(bodyEl);
      container.appendChild(inputRowEl);
      const pane = _buildChatPane({
        bodyEl: bodyEl,
        inputRowEl: inputRowEl,
        cardId: options.cardId,
        isModal: false,
        options: {
          placeholder: options.placeholder,
          showEmptyState: options.showEmptyState !== false,
          fileAttach: options.fileAttach !== false,
          fileAccept: options.fileAccept || null,
          autoSubscribe: options.autoSubscribe !== false,
        },
      });
      return {
        refresh: function () { pane.refresh(); },
        dispose: function () { pane.dispose(); },
      };
    }


    function _currentNodeFiles(nodeId) {
      const node = cfg.resolve(nodeId);
      const files = node && node.card_data && Array.isArray(node.card_data.files) ? node.card_data.files : [];
      return files.filter(Boolean);
    }

    function _filesDisabled(nodeId) {
      const node = nodeId ? cfg.resolve(nodeId) : null;
      return !!(node && node.card_data && node.card_data.features && node.card_data.features.files && node.card_data.features.files.disabled);
    }

    // ---------------------------------------------------------------------------
    // Files list pane builder (read-only download view)
    //
    // Renders card_data.files as a Bootstrap list-group with name + size +
    // Download anchor — same DOM the modal body uses today. Polls 1s by
    // default so the list reflects newly-uploaded files without an external
    // notify.
    // ---------------------------------------------------------------------------
    function _buildFilesListPane(spec: any) {
      const opts = Object.assign({
        emptyText: 'No files uploaded yet.',
        livePoll: true,
      }, (spec && spec.options) || {});

      const pane: any = {
        kind: 'files-list',
        container: spec.container,
        cardId: spec.cardId || null,
        isModal: !!spec.isModal,
        disposed: false,
        pollingTimer: null,
        options: opts,
      };

      pane.refresh = function () {
        if (pane.disposed || !pane.container) return;
        if (!pane.cardId) { pane.container.innerHTML = ''; return; }
        const files = _currentNodeFiles(pane.cardId);
        if (!files.length) {
          pane.container.innerHTML = '<div class="alert alert-light border small mb-0">' + _esc(opts.emptyText) + '</div>';
          return;
        }
        let h = '<div class="list-group list-group-flush">';
        files.forEach(function (f, idx) {
          const fileName = f && (f.name || f.stored_name) ? (f.name || f.stored_name) : 'file';
          const sizeText = f && typeof f.size === 'number' ? ('size: ' + f.size + ' bytes') : '';
          const stored = f && f.stored_name ? String(f.stored_name) : '';
          const isChatFile = !!(f && f.chat === true);
          const originBadge = isChatFile
            ? '<span class="badge text-bg-info-subtle border border-info-subtle text-info-emphasis ms-2" data-lc-file-origin="chat">Chat</span>'
            : '<span class="badge text-bg-light border ms-2" data-lc-file-origin="card">Card</span>';
          const dl = stored
            ? cfg.fileUrlBase + '/cards/' + encodeURIComponent(pane.cardId) + '/files/' + idx + '?sn=' + encodeURIComponent(stored)
            : null;
          h += '<div class="list-group-item d-flex align-items-center justify-content-between gap-2">';
          h += '<div class="text-truncate"><div class="small fw-medium d-flex align-items-center flex-wrap">' + _esc(fileName) + originBadge + '</div>';
          h += '<div class="small text-muted">' + _esc(sizeText) + '</div></div>';
          if (dl) {
            h += '<a class="btn btn-sm btn-outline-secondary flex-shrink-0" href="' + dl + '">Download</a>';
          }
          h += '</div>';
        });
        h += '</div>';
        pane.container.innerHTML = h;
      };

      pane.dispose = function () {
        if (pane.disposed) return;
        pane.disposed = true;
        if (pane.pollingTimer) { clearInterval(pane.pollingTimer); pane.pollingTimer = null; }
        _filesPanes.delete(pane);
      };

      _filesPanes.add(pane);
      pane.refresh();
      if (opts.livePoll) {
        pane.pollingTimer = setInterval(function () { pane.refresh(); }, 1000);
      }
      return pane;
    }

    // ---------------------------------------------------------------------------
    // Files upload pane builder (drop zone + staged + Upload button)
    //
    // Same DOM/classes (lc-dropzone, lc-drag-over, lc-disabled, etc.) the
    // modal footer uses today. If showUploadedList is true, also renders an
    // embedded files-list pane above the drop zone — letting the inline pane
    // be a self-contained replacement for the modal body+footer.
    //
    // spec: {
    //   container: HTMLElement,
    //   cardId: string,
    //   isModal?: boolean,
    //   listPaneEl?: HTMLElement,    // when set, list renders here instead of inside container (used by modal)
    //   options?: {
    //     placeholder?: string,      // dropzone hint text
    //     accept?: string[],         // input[type=file] accept attribute
    //     showUploadedList?: boolean,
    //     livePoll?: boolean,
    //   }
    // }
    // ---------------------------------------------------------------------------
    function _buildFilesUploadPane(spec: any) {
      const opts = Object.assign({
        placeholder: 'Drop files here or click to browse',
        accept: null,
        showUploadedList: true,
        livePoll: true,
      }, (spec && spec.options) || {});

      const pane: any = {
        kind: 'files-upload',
        container: spec.container,
        cardId: spec.cardId || null,
        isModal: !!spec.isModal,
        disposed: false,
        loading: false,
        stagedFiles: [] as any[],
        options: opts,
        // sub-pane: an embedded files-list pane (or null if showUploadedList=false)
        listPane: null as any,
      };

      // Layout: optional list pane on top, then dropzone + staged + actions.
      // When the modal supplies an external listPaneEl (the modal body), the
      // list pane is built there; otherwise it's inserted inside container.
      pane.container.innerHTML = '';
      const acceptAttr = opts.accept && Array.isArray(opts.accept) && opts.accept.length
        ? ' accept="' + _esc(opts.accept.join(',')) + '"'
        : '';
      pane.container.innerHTML =
        '<div class="lc-dropzone border-2 border-dashed p-4 text-center cursor-pointer rounded" data-lc-files-dz>' +
          '<div class="small text-muted mb-2">' + _esc(opts.placeholder) + '</div>' +
          '<input type="file" class="d-none" data-lc-files-input multiple' + acceptAttr + '>' +
        '</div>' +
        '<div data-lc-files-staged class="small w-100 d-flex flex-wrap gap-2 mt-2"></div>' +
        '<div class="d-flex justify-content-end gap-2 w-100 mt-2">' +
          '<button type="button" class="btn btn-sm btn-outline-secondary" data-lc-files-attach>Select files</button>' +
          '<button type="button" class="btn btn-sm btn-primary" data-lc-files-upload>Upload</button>' +
        '</div>';

      pane.dropzone = pane.container.querySelector('[data-lc-files-dz]');
      pane.fileInput = pane.container.querySelector('[data-lc-files-input]');
      pane.staged = pane.container.querySelector('[data-lc-files-staged]');
      pane.attachBtn = pane.container.querySelector('[data-lc-files-attach]');
      pane.uploadBtn = pane.container.querySelector('[data-lc-files-upload]');

      // Embed an inline list pane (either inside our container or in the
      // modal-provided body element).
      if (opts.showUploadedList || spec.listPaneEl) {
        let listHost: HTMLElement;
        if (spec.listPaneEl) {
          listHost = spec.listPaneEl;
        } else {
          listHost = document.createElement('div');
          listHost.className = 'lc-files-uploaded-list mb-2';
          pane.container.insertBefore(listHost, pane.dropzone);
        }
        pane.listPane = _buildFilesListPane({
          container: listHost,
          cardId: pane.cardId,
          isModal: pane.isModal,
          options: { livePoll: opts.livePoll },
        });
      }

      function renderStagedFiles() {
        if (!pane.stagedFiles.length) { pane.staged.innerHTML = ''; return; }
        pane.staged.innerHTML = pane.stagedFiles.map(function (f, i) {
          return '<span class="badge text-bg-light border me-1 mb-1">' + _esc(f.name || 'file') +
            ' <button type="button" class="btn btn-sm btn-link text-danger p-0 ms-1" data-lc-files-rm="' + i + '">&times;</button></span>';
        }).join('');
        pane.staged.querySelectorAll('[data-lc-files-rm]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            const idx = parseInt(btn.getAttribute('data-lc-files-rm') || '-1', 10);
            if (idx >= 0) pane.stagedFiles.splice(idx, 1);
            renderStagedFiles();
          });
        });
      }
      pane.renderStagedFiles = renderStagedFiles;

      function addFiles(fileList) {
        const files = Array.from(fileList || []);
        for (const f of files) {
          const ff: any = f;
          if (!pane.stagedFiles.find(function (x) { return x.name === ff.name && x.size === ff.size && x.lastModified === ff.lastModified; })) {
            pane.stagedFiles.push(ff);
          }
        }
        renderStagedFiles();
      }

      pane.syncDisabledState = function () {
        const disabled = _filesDisabled(pane.cardId);
        if (pane.dropzone) pane.dropzone.classList.toggle('lc-disabled', disabled);
        if (pane.attachBtn) pane.attachBtn.disabled = disabled || pane.loading;
        if (pane.uploadBtn) pane.uploadBtn.disabled = disabled || pane.loading;
        if (pane.fileInput) pane.fileInput.disabled = disabled;
      };

      async function uploadFiles() {
        if (pane.loading || !pane.cardId || !pane.stagedFiles.length || pane.disposed) return;
        const nodeId = pane.cardId;
        const files = pane.stagedFiles.slice();
        pane.loading = true;
        pane.uploadBtn.disabled = true;
        pane.attachBtn.disabled = true;
        pane.dropzone.classList.add('lc-disabled');
        try {
          await Promise.resolve(cfg.onAction(nodeId, 'file-upload', { files }));
          pane.stagedFiles = [];
          renderStagedFiles();
          if (pane.listPane) pane.listPane.refresh();
        } catch (err) {
          pane.staged.innerHTML = '<span class="text-danger">Upload failed: ' + _esc(String((err && err.message) || err)) + '</span>';
        } finally {
          pane.loading = false;
          pane.syncDisabledState();
        }
      }
      pane.uploadFiles = uploadFiles;

      const _listeners: Array<{ t: any; e: string; h: any }> = [];
      function on(target, evt, handler) {
        target.addEventListener(evt, handler);
        _listeners.push({ t: target, e: evt, h: handler });
      }
      on(pane.attachBtn, 'click', function () { pane.fileInput.click(); });
      on(pane.fileInput, 'change', function (evt) {
        addFiles(evt.target && evt.target.files ? evt.target.files : []);
        evt.target.value = '';
      });
      on(pane.uploadBtn, 'click', uploadFiles);
      on(pane.dropzone, 'click', function () {
        if (!pane.loading && !_filesDisabled(pane.cardId)) pane.fileInput.click();
      });
      on(pane.dropzone, 'dragover', function (evt) {
        evt.preventDefault();
        pane.dropzone.classList.add('lc-drag-over');
      });
      on(pane.dropzone, 'dragleave', function () {
        pane.dropzone.classList.remove('lc-drag-over');
      });
      on(pane.dropzone, 'drop', function (evt) {
        evt.preventDefault();
        pane.dropzone.classList.remove('lc-drag-over');
        if (_filesDisabled(pane.cardId)) return;
        addFiles(evt.dataTransfer && evt.dataTransfer.files ? evt.dataTransfer.files : []);
      });

      pane.refresh = function () {
        if (pane.disposed) return;
        pane.syncDisabledState();
        if (pane.listPane) {
          pane.listPane.cardId = pane.cardId;
          pane.listPane.refresh();
        }
      };

      pane.dispose = function () {
        if (pane.disposed) return;
        pane.disposed = true;
        _listeners.forEach(function (l) {
          try { l.t.removeEventListener(l.e, l.h); } catch (e) { /* noop */ }
        });
        _listeners.length = 0;
        if (pane.listPane) { try { pane.listPane.dispose(); } catch (e) { /* noop */ } }
        pane.stagedFiles = [];
        _filesPanes.delete(pane);
      };

      _filesPanes.add(pane);
      pane.syncDisabledState();
      return pane;
    }

    function _ensureFilesModal() {
      if (_filesModalRefs.backdrop) return;

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
        '    <div class="modal-footer flex-column align-items-stretch border-top p-3 gap-3" data-lc-files-footer></div>' +
        '  </div>' +
        '</div>';

      document.body.appendChild(backdrop);
      const bodyEl = backdrop.querySelector('[data-lc-files-body]') as HTMLElement;
      const footerEl = backdrop.querySelector('[data-lc-files-footer]') as HTMLElement;
      const titleEl = backdrop.querySelector('.lc-files-modal-title');
      const closeBtn = backdrop.querySelector('[data-lc-files-close]');

      _filesModalRefs.backdrop = backdrop;
      _filesModalRefs.title = titleEl;
      _filesModalRefs.closeBtn = closeBtn;

      // The modal composes an upload pane (in footer) whose embedded list pane
      // is hoisted into the modal body — preserving the original layout.
      _filesModalUploadPane = _buildFilesUploadPane({
        container: footerEl,
        cardId: null,
        isModal: true,
        listPaneEl: bodyEl,
        options: { showUploadedList: true, livePoll: false },
      });
      // The list pane reference for the modal is the one embedded in the upload pane.
      _filesModalListPane = _filesModalUploadPane.listPane;

      const close = function () {
        const closingNodeId = _filesModalRefs.currentNodeId;
        _filesModalRefs.currentNodeId = null;
        if (_filesModalUploadPane) {
          _filesModalUploadPane.cardId = null;
          _filesModalUploadPane.stagedFiles = [];
          if (_filesModalUploadPane.staged) _filesModalUploadPane.staged.innerHTML = '';
        }
        if (_filesModalListPane) _filesModalListPane.cardId = null;
        backdrop.classList.remove('lc-open');
        if (_filesModalRefs.pollingTimer) {
          clearInterval(_filesModalRefs.pollingTimer);
          _filesModalRefs.pollingTimer = null;
        }
        // No subscription lifecycle for files today; closingNodeId reserved for parity.
        void closingNodeId;
      };

      closeBtn.addEventListener('click', close);
      backdrop.addEventListener('click', function (evt) {
        if (evt.target === backdrop) close();
      });
      document.addEventListener('keydown', function (evt) {
        if (evt.key === 'Escape' && backdrop.classList.contains('lc-open')) close();
      });
    }

    function openFilesModal(nodeId) {
      _ensureFilesModal();
      const node = cfg.resolve(nodeId);
      if (!node) return;

      const title = (node.card && node.card.meta && node.card.meta.title) || node.id;
      _filesModalRefs.currentNodeId = nodeId;
      _filesModalRefs.title.textContent = 'Files: ' + title;
      _filesModalRefs.backdrop.classList.add('lc-open');

      // Bind the modal panes to the card and refresh.
      _filesModalUploadPane.cardId = nodeId;
      _filesModalListPane.cardId = nodeId;
      _filesModalUploadPane.refresh();

      if (_filesModalRefs.pollingTimer) clearInterval(_filesModalRefs.pollingTimer);
      _filesModalRefs.pollingTimer = setInterval(function () {
        if (_filesModalListPane) _filesModalListPane.refresh();
      }, 1000);
    }

    // Public: mount an upload pane (drop zone + staged + Upload button, with
    // optional embedded uploaded-list) inside a caller-owned container. Same
    // code path as the modal footer.
    function mountFilesUploadPane(options) {
      options = options || {};
      if (!options.container) throw new Error('mountFilesUploadPane: container is required');
      if (!options.cardId) throw new Error('mountFilesUploadPane: cardId is required');
      const pane = _buildFilesUploadPane({
        container: options.container,
        cardId: options.cardId,
        isModal: false,
        options: {
          placeholder: options.placeholder,
          accept: options.accept || null,
          showUploadedList: options.showUploadedList !== false,
          livePoll: options.livePoll !== false,
        },
      });
      return {
        refresh: function () { pane.refresh(); },
        dispose: function () { pane.dispose(); },
      };
    }

    // Public: mount a read-only files list pane (list-group with name + size
    // + Download anchor) inside a caller-owned container. Same code path as
    // the modal body.
    function mountFilesListPane(options) {
      options = options || {};
      if (!options.container) throw new Error('mountFilesListPane: container is required');
      if (!options.cardId) throw new Error('mountFilesListPane: cardId is required');
      const pane = _buildFilesListPane({
        container: options.container,
        cardId: options.cardId,
        isModal: false,
        options: {
          emptyText: options.emptyText || 'No files uploaded yet.',
          livePoll: options.livePoll !== false,
        },
      });
      return {
        refresh: function () { pane.refresh(); },
        dispose: function () { pane.dispose(); },
      };
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
        requires: node && node.requires ? node.requires : {},
        computed_values: node && node.computed_values ? node.computed_values : {},
        runtime_state: node && node.runtime_state ? node.runtime_state : {},
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

      // Resolve required tokens to upstream node IDs via provides declarations.
      // Build a token→nodeId map from all nodes the engine knows about.
      const tokenMap = {};
      const allNodeIds = Object.keys(_subs).concat(Object.keys(_nodeEls));
      allNodeIds.forEach(function(nid) {
        const n = cfg.resolve(nid);
        if (!n || !n.card) return;
        var provides = (Array.isArray(n.card.provides) && n.card.provides.length)
          ? n.card.provides.map(function(p) { return typeof p === 'string' ? p : (p.bindTo || p); })
          : [n.id];
        provides.forEach(function(tok) { tokenMap[tok] = n.id; });
      });

      // Subscribe to each upstream provider node (deduplicated)
      const seen = {};
      const upIds = [];
      requires.forEach(function(token) {
        var srcId = tokenMap[token] || token; // fallback: treat token as nodeId
        if (!seen[srcId]) { seen[srcId] = true; upIds.push(srcId); }
      });

      cleanup.unsubs = upIds.map(upId => subscribe(upId, () => {
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

      const stateKey = node.id + ':' + (ed.bind || writeTo || '');
      const baseValues = (data && typeof data === 'object' && !Array.isArray(data)) ? Object.assign({}, data) : {};

      if (!_formState[stateKey]) {
        _formState[stateKey] = { baseValues, journal: {} };
      } else {
        _formState[stateKey].baseValues = baseValues;
        Object.keys(_formState[stateKey].journal).forEach(key => {
          if (_same(_formState[stateKey].journal[key], baseValues[key])) {
            delete _formState[stateKey].journal[key];
          }
        });
      }

      const st = _formState[stateKey];

      function _toInputValue(prop, inp) {
        if (prop.type === 'boolean') return !!inp.checked;
        if (prop.type === 'number' || prop.type === 'integer') return inp.value !== '' ? parseFloat(inp.value) : 0;
        return inp.value;
      }

      function _same(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
      }

      function getEffectiveValues() {
        return Object.assign({}, st.baseValues, st.journal);
      }

      function isDirty() {
        return Object.keys(st.journal).length > 0;
      }

      // Capture user edits into a journal overlay (only changed keys).
      function captureJournal(form) {
        form.querySelectorAll('[data-key]').forEach(inp => {
          const k = inp.dataset.key;
          const p = props[k];
          if (!p) return;
          const nextVal = _toInputValue(p, inp);
          const baseVal = st.baseValues[k];
          if (_same(nextVal, baseVal)) delete st.journal[k];
          else st.journal[k] = nextVal;
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
        // Populate from effective values (base bind overlaid by local journal).
        const v = getEffectiveValues()[key];
        if (v != null) {
          if (prop.type === 'boolean') input.checked = !!v;
          else if (prop.format === 'date') input.value = String(v).slice(0, 10);
          else input.value = v;
        }
        form.appendChild(col);
      });

      const btnCol = document.createElement('div');
      btnCol.className = 'col-12 mt-1';
      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'btn btn-sm btn-outline-secondary me-2' + (isDirty() ? '' : ' d-none');
      discardBtn.textContent = 'Discard';
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.className = 'btn btn-sm btn-primary' + (isDirty() ? '' : ' d-none');
      btn.textContent = 'Save';
      btnCol.appendChild(discardBtn);
      btnCol.appendChild(btn);
      form.appendChild(btnCol);

      el.innerHTML = '';
      el.appendChild(form);

      // Real-time input → update journal + toggle Save/Discard buttons
      form.addEventListener('input', () => {
        captureJournal(form);
        const dirty = isDirty();
        btn.classList.toggle('d-none', !dirty);
        discardBtn.classList.toggle('d-none', !dirty);
      }, { signal });

      form.addEventListener('submit', e => {
        e.preventDefault();
        if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
        captureJournal(form);
        const nextValues = getEffectiveValues();
        cfg.onPatchState(node.id, { fieldValues: nextValues });
        btn.textContent = 'Saving...';
        _showSavingOverlay(el);
      }, { signal });

      discardBtn.addEventListener('click', () => {
        st.journal = {};
        form.querySelectorAll('[data-key]').forEach(inp => {
          const k = inp.dataset.key;
          const p = props[k];
          if (!p) return;
          const v = st.baseValues[k];
          if (p.type === 'boolean') inp.checked = !!v;
          else if (p.format === 'date') inp.value = v != null ? String(v).slice(0, 10) : '';
          else inp.value = v != null ? v : '';
        });
        discardBtn.classList.add('d-none');
        btn.classList.add('d-none');
      }, { signal });
    }

    // ---- notes ----

    function _renderNotes(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const writeTo = ed.writeTo;
      const incomingContent = typeof data === 'string' ? data : '';

      // Base + journal overlay model:
      // effective = journal when present, else baseContent from bind.
      const stateKey = node.id + ':' + ((ed.bind || writeTo) || '');
      if (!_notesState[stateKey]) {
        _notesState[stateKey] = { baseContent: incomingContent, journal: null };
      } else {
        _notesState[stateKey].baseContent = incomingContent;
        if (_notesState[stateKey].journal === incomingContent) {
          _notesState[stateKey].journal = null;
        }
      }
      const st = _notesState[stateKey];

      function isDirty() {
        return st.journal != null;
      }

      function getEffectiveContent() {
        return st.journal != null ? st.journal : st.baseContent;
      }

      function setJournal(nextValue) {
        st.journal = nextValue === st.baseContent ? null : nextValue;
      }

      el.innerHTML = `
        <textarea class="form-control form-control-sm lc-notes-textarea" rows="8" placeholder="Write markdown...">${_esc(getEffectiveContent())}</textarea>
        <div class="mt-2">
          <button class="btn btn-sm btn-outline-secondary me-2 lc-n-discard${isDirty() ? '' : ' d-none'}" type="button">Discard</button>
          <button class="btn btn-sm btn-primary lc-n-save${isDirty() ? '' : ' d-none'}" type="button">Save</button>
        </div>`;

      const textarea = el.querySelector('.lc-notes-textarea');
      const discardBtn = el.querySelector('.lc-n-discard');
      const saveBtn = el.querySelector('.lc-n-save');

      function syncDirtyButtons() {
        const dirty = isDirty();
        saveBtn.classList.toggle('d-none', !dirty);
        discardBtn.classList.toggle('d-none', !dirty);
      }

      textarea.addEventListener('input', () => {
        setJournal(textarea.value);
        syncDirtyButtons();
      }, { signal });

      saveBtn.addEventListener('click', () => {
        const nextValue = textarea.value;
        // Wrap in a named key so spread into card_data gives card_data.notes = "..."
        // (same dict pattern as form/filter; writeTo is not required).
        cfg.onPatchState(node.id, { fieldValues: { notes: nextValue } });
        saveBtn.textContent = 'Saving...';
        _showSavingOverlay(el);
      }, { signal });

      discardBtn.addEventListener('click', () => {
        st.journal = null;
        textarea.value = st.baseContent || '';
        syncDirtyButtons();
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
      // Standard convention:
      // - bind = read source
      // - writeTo = explicit write target for editable views
      // If bind already points at card_data, default writeTo to bind.
      const writeTo = ed.writeTo || ((typeof ed.bind === 'string' && ed.bind.startsWith('card_data.')) ? ed.bind : undefined);
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

      // Base + journal overlay model:
      // effectiveRows = journalRows if present, else baseRows(bind).
      // Dirty is determined by journal presence (supports Save/Discard UX).
      const stateKey = node.id + ':' + (ed.bind || writeTo || '');
      const incomingRows = Array.isArray(data) ? data : [];
      const incomingCopy = incomingRows.map(r => Object.assign({}, r));

      if (!_etState[stateKey]) {
        _etState[stateKey] = { baseRows: incomingCopy, journalRows: null };
      } else {
        _etState[stateKey].baseRows = incomingCopy;
        if (_etState[stateKey].journalRows && JSON.stringify(_etState[stateKey].journalRows) === JSON.stringify(incomingCopy)) {
          _etState[stateKey].journalRows = null;
        }
      }

      const st = _etState[stateKey];

      function isDirty() {
        return Array.isArray(st.journalRows);
      }

      function getEffectiveRows() {
        const rows = Array.isArray(st.journalRows) ? st.journalRows : st.baseRows;
        return rows.map(r => Object.assign({}, r));
      }

      function updateJournal(nextRows) {
        if (JSON.stringify(nextRows) === JSON.stringify(st.baseRows)) st.journalRows = null;
        else st.journalRows = nextRows.map(r => Object.assign({}, r));
      }

      function markDirty() {
        const saveBtn = el.querySelector('.lc-et-save');
        const discardBtn = el.querySelector('.lc-et-discard');
        if (saveBtn) saveBtn.classList.remove('d-none');
        if (discardBtn) discardBtn.classList.remove('d-none');
      }

      function commitSave() {
        const rows = getEffectiveRows();
        cfg.onPatchState(node.id, { fieldValues: rows });
        const saveBtn = el.querySelector('.lc-et-save');
        if (saveBtn) saveBtn.textContent = 'Saving...';
        _showSavingOverlay(el);
      }

      function commitDiscard() {
        st.journalRows = null;
        build();
      }

      function build() {
        const rows = getEffectiveRows();
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
        footer += `<button class="btn btn-sm btn-outline-secondary mt-1 me-1 lc-et-discard${isDirty() ? '' : ' d-none'}">Discard</button>`;
        footer += `<button class="btn btn-sm btn-primary mt-1 lc-et-save${isDirty() ? '' : ' d-none'}">Save</button>`;
        el.innerHTML = h + footer;

        // Cell edit → update journal overlay and toggle Save/Discard.
        el.querySelectorAll('.lc-et-cell').forEach(inp => {
          inp.addEventListener('change', () => {
            const rowIdx  = parseInt(inp.dataset.row);
            const colName = inp.dataset.col;
            const prop    = schemaProps[colName] || {};
            const isNum   = prop.type === 'number' || prop.type === 'integer' || inp.type === 'number';
            const nextRows = getEffectiveRows();
            if (!nextRows[rowIdx]) return;
            nextRows[rowIdx] = Object.assign({}, nextRows[rowIdx]);
            nextRows[rowIdx][colName] = isNum ? (inp.value !== '' ? parseFloat(inp.value) : 0) : inp.value;
            updateJournal(nextRows);
            if (isDirty()) markDirty();
            else {
              const saveBtn = el.querySelector('.lc-et-save');
              const discardBtn = el.querySelector('.lc-et-discard');
              if (saveBtn) saveBtn.classList.add('d-none');
              if (discardBtn) discardBtn.classList.add('d-none');
            }
          }, { signal });
        });

        // Delete row — updates journal and rebuilds.
        el.querySelectorAll('.lc-et-del').forEach(btn => {
          btn.addEventListener('click', () => {
            const rowIdx = parseInt(btn.dataset.row);
            const nextRows = getEffectiveRows().filter((_, i) => i !== rowIdx);
            updateJournal(nextRows);
            build();
          }, { signal });
        });

        // Add row — appends blank row to journal and rebuilds.
        const addBtn = el.querySelector('.lc-et-add');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            const newRow = {};
            const nextRows = getEffectiveRows();
            getCols(nextRows).forEach(c => { newRow[c] = ''; });
            nextRows.push(newRow);
            updateJournal(nextRows);
            build();
          }, { signal });
        }

        // Save/Discard controls.
        const discardBtn = el.querySelector('.lc-et-discard');
        if (discardBtn) {
          discardBtn.addEventListener('click', () => {
            commitDiscard();
          }, { signal });
        }

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
          const downloadUrl = `${cfg.fileUrlBase}/cards/${encodeURIComponent(cardId)}/files/${idx}?sn=${encodeURIComponent(file.stored_name)}`;
          const size = file.size ? ` (${Math.round(file.size / 1024)}KB)` : '';
          const originAttr = file.chat === true ? 'chat' : 'card';
          const originBadge = file.chat === true
            ? '<span class="badge text-bg-info-subtle border border-info-subtle text-info-emphasis ms-2" data-lc-file-origin="chat">Chat</span>'
            : '<span class="badge text-bg-light border ms-2" data-lc-file-origin="card">Card</span>';
          htmlParts.push(`<div class="mb-2 d-flex align-items-center flex-wrap gap-2" data-lc-file-link-origin="${originAttr}"><a href="${downloadUrl}" class="btn btn-sm btn-outline-secondary">${_esc(name)}${_esc(size)}</a>${originBadge}</div>`);
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

    // ---- ref ----
    // Indirection element: resolves a bind path to get the view definition,
    // then dispatches to the real renderer. The resolved value may be:
    //   - a string  → treated directly as the element kind ("table", "chart", etc.)
    //   - an object → { kind, label, data: { columns, chartType, chartOptions, writeTo } }
    //                 merged with static elemDef (static fields win for protection)
    //   - null/undefined → falls back to elemDef.data.fallbackKind or shape-inferred kind
    //
    // Allowed kinds from resolved value (whitelist, unknown → "table"):
    //   table, editable-table, chart, metric, list, badge, text, narrative, markdown
    //
    // Usage:
    //   { "kind": "ref",
    //     "data": { "bind": "computed_values.proposed_trades",
    //               "viewBind": "card_data.display_mode",
    //               "fallbackKind": "table" } }
    //
    // viewBind can point to any namespace: card_data, requires, computed_values, runtime_state.
    // If the resolved view object contains a "bind" sub-path, that overrides data.bind.
    const _REF_KIND_WHITELIST = new Set([
      'table','editable-table','chart','metric','list','badge',
      'text','narrative','markdown','form','filter','todo','alert',
    ]);
    function _renderRef(data, el, elemDef, node) {
      const ed = elemDef.data || {};

      // Resolve the view hint
      const viewRaw = ed.viewBind ? _resolveBind(node, ed.viewBind) : undefined;

      let resolvedKind, resolvedExtra;
      if (typeof viewRaw === 'string' && viewRaw) {
        resolvedKind  = viewRaw;
        resolvedExtra = {};
      } else if (viewRaw && typeof viewRaw === 'object' && !Array.isArray(viewRaw)) {
        resolvedKind  = typeof viewRaw.kind === 'string' ? viewRaw.kind : undefined;
        resolvedExtra = viewRaw.data && typeof viewRaw.data === 'object' ? viewRaw.data : {};
      }

      // Validate kind against whitelist; fall back to shape inference
      if (!resolvedKind || !_REF_KIND_WHITELIST.has(resolvedKind)) {
        resolvedKind = ed.fallbackKind && _REF_KIND_WHITELIST.has(ed.fallbackKind)
          ? ed.fallbackKind
          : (Array.isArray(data) ? 'table' : typeof data === 'string' ? 'text' : 'narrative');
      }

      // Build effective elemDef: resolved hints first, static elemDef fields override (card author wins)
      const mergedData = Object.assign({}, resolvedExtra, ed);
      delete mergedData.viewBind;
      delete mergedData.fallbackKind;

      // If the resolved hint provided its own bind path, honour it (but static ed.bind still wins)
      if (!mergedData.bind && resolvedExtra.bind) mergedData.bind = resolvedExtra.bind;

      const effectiveElemDef = Object.assign({}, elemDef, { kind: resolvedKind }, { data: mergedData });

      // Re-resolve data using effective bind (may have changed)
      const effectiveData = mergedData.bind ? _resolveBind(node, mergedData.bind) : data;

      const renderer = _renderers[resolvedKind] || _renderers.table;
      renderer(effectiveData, el, effectiveElemDef, node);
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
    _renderers.actions        = _renderActions;
    _renderers.ref            = _renderRef;

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

      h += '</div>';
      containerEl.innerHTML = h;

      // ---- Render elements ----
      const resultEl = document.getElementById(uid + '-result');
      _nodeEls[node.id] = { container: containerEl, resultEl, uid };

      if (node.card_data && node.card_data.status === 'error' && node.card_data.error) {
        resultEl.innerHTML = `<div class="text-danger small fw-semibold">Refresh failed</div><pre class="text-muted small mt-1" style="white-space:pre-wrap">${_esc(node.card_data.error)}</pre>`;
      } else {
        _renderElements(node, resultEl);
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
        _renderElements(node, info.resultEl);
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
      // Dispose every mounted chat pane (modal + inline). dispose() removes
      // listeners and unsubscribes auto-subscribed panes.
      Array.from(_chatPanes).forEach(function (pane) {
        try { pane.dispose(); } catch (e) { /* noop */ }
      });
      _chatPanes.clear();
      if (_chatModalRefs.backdrop) _chatModalRefs.backdrop.remove();
      _chatModalRefs.backdrop = null;
      _chatModalRefs.title = null;
      _chatModalRefs.closeBtn = null;
      _modalPane = null;

      if (_filesModalRefs.pollingTimer) clearInterval(_filesModalRefs.pollingTimer);
      Array.from(_filesPanes).forEach(function (pane) {
        try { pane.dispose(); } catch (e) { /* noop */ }
      });
      _filesPanes.clear();
      if (_filesModalRefs.backdrop) _filesModalRefs.backdrop.remove();
      _filesModalRefs.backdrop = null;
      _filesModalRefs.title = null;
      _filesModalRefs.closeBtn = null;
      _filesModalRefs.currentNodeId = null;
      _filesModalRefs.pollingTimer = null;
      _filesModalUploadPane = null;
      _filesModalListPane = null;
    }

    // ===========================================================================
    // Chat
    // ===========================================================================

    function _isModalOpen() {
      return !!(_chatModalRefs.backdrop && _chatModalRefs.backdrop.classList.contains('lc-open'));
    }

    // True for the modal pane only when the modal is currently open; always
    // true for inline panes (their visibility is the caller's responsibility).
    function _paneIsActive(pane) {
      if (!pane || !pane.cardId || pane.disposed) return false;
      if (pane.isModal) return _isModalOpen();
      return true;
    }

    function appendChatMessage(nodeId, role, text) {
      _chatPanes.forEach(function (pane) {
        if (!_paneIsActive(pane)) return;
        if (pane.cardId !== nodeId) return;
        pane.appendMessage(role, text, []);
      });
    }

    function refreshOpenChatModal() {
      _chatPanes.forEach(function (pane) {
        if (!_paneIsActive(pane)) return;
        pane.refresh();
      });
    }

    function onServerSseEvent() {
      _chatPanes.forEach(function (pane) {
        if (!_paneIsActive(pane)) return;
        if (pane.awaitingProcessingAck) pane.setSendButtonPending(false);
        pane.clearPending();
        pane.syncProcessingBar();
        pane.refresh();
      });
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
      mountChatPane,
      openFilesModal,
      mountFilesUploadPane,
      mountFilesListPane,
      getElement,
      registerRenderer(name, fn) { _renderers[name] = fn; },
      renderers: _renderers,
      // Chat lifecycle helpers — called by custom renderers and BoardCore
      getChatStateForCard(cardId) {
        const node = cfg.resolve(cardId);
        return node ? _chatStateFromCardState(node) : { messages: [], receiving: false, processing: false };
      },
      startReceivingChatsForCard(cardId) {
        if (typeof cfg.startReceivingChats === 'function') cfg.startReceivingChats(cardId);
      },
      stopReceivingChatsForCard(cardId) {
        if (typeof cfg.stopReceivingChats === 'function') cfg.stopReceivingChats(cardId);
      },
      isReceivingChatsForCard(cardId) {
        const node = cfg.resolve(cardId);
        if (!node || !node.card_chats) return false;
        return !!node.card_chats.receiving;
      },
    };
  }

  // ===========================================================================
  // BoardCore — imperative grid (board) and DAG (canvas) modes.
  // Most callers should use Board (reactive wrapper) instead.
  // ===========================================================================

  function BoardCore(engine, containerEl, opts) {
    opts = opts || {};
    const mode = { current: opts.mode || 'board' };
    const devMode = { current: opts.devMode || false };
    const nodeList = [];
    const nodeMap = {};        // id → { node, colEl, bodyEl }
    const _positions = {};     // id → { x, y, w, h } for canvas mode
    const showChat  = opts.showChat || false;
    const defaultCol = opts.defaultCol || 6;
    const registeredBoardTheme = _resolveRegistryEntry(opts.boardTheme, _globalBoardThemes);
    const boardRenderer = _resolveRegistryEntry(opts.boardRenderer, _globalBoardRenderers);
    const explicitBoardSkin = _mergeBoardPresentation(
      opts.boardSkin,
      {
        boardClass: opts.boardClass,
        listClass: opts.listClass,
        canvasClass: opts.canvasClass,
        canvasInnerClass: opts.canvasInnerClass,
        styles: opts.styles,
        boardStyle: opts.boardStyle,
        listStyle: opts.listStyle,
        canvasStyle: opts.canvasStyle,
        canvasInnerStyle: opts.canvasInnerStyle,
      },
    );

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
    const _edges = [];        // LeaderLine instances for canvas edges

    // Edge style config (from canvas opts)
    const edgeOpts = co.edgeStyle || {};
    const edgeCfg = {
      color:     edgeOpts.color || 'rgba(108, 117, 125, 0.6)',
      size:      edgeOpts.size || 2,
      dash:      edgeOpts.dash !== false,
      animation: edgeOpts.animation !== false,
      endPlug:   edgeOpts.endPlug || 'arrow1',
    };

    // DOM containers
    const root = document.createElement('div');
    root.className = 'lc-board';
    containerEl.appendChild(root);
    let boardScopedStyleEl = null;
    let _lastBoardHost = { mountEl: root, listEl: root };

    const gridEl = document.createElement('div');
    gridEl.className = 'row g-3 lc-board-grid';

    const canvasEl = document.createElement('div');
    canvasEl.className = 'lc-canvas';
    canvasEl.style.cssText = 'position:relative;overflow:auto;width:100%;';
    const canvasInner = document.createElement('div');
    canvasInner.className = 'lc-canvas-inner';
    canvasInner.style.cssText = 'position:relative;transform-origin:0 0;min-width:100%;min-height:100%;';
    canvasEl.appendChild(canvasInner);

    // SVG overlay for edges
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('class', 'lc-canvas-edges');
    svgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:0;';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="lc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 8 5 L 0 9 z" fill="rgba(108,117,125,0.55)"/></marker>';
    svgEl.appendChild(defs);
    canvasInner.appendChild(svgEl);

    function _currentBoardPresentation() {
      const compatSkin = _deriveBoardPresentationFromNodes(nodeList);
      return _mergeBoardPresentation(compatSkin, registeredBoardTheme, explicitBoardSkin);
    }

    function _syncBoardScopedStyles(presentation) {
      const cssText = [
        presentation && presentation.styles,
        boardRenderer && typeof boardRenderer.styles === 'string' ? boardRenderer.styles : '',
      ].filter(function(v) { return typeof v === 'string' && v.trim(); }).join('\n');
      if (!cssText) {
        if (boardScopedStyleEl && boardScopedStyleEl.parentNode) boardScopedStyleEl.parentNode.removeChild(boardScopedStyleEl);
        boardScopedStyleEl = null;
        return;
      }
      if (!boardScopedStyleEl) {
        boardScopedStyleEl = document.createElement('style');
        boardScopedStyleEl.setAttribute('data-lc-board-scope', '1');
        document.head.appendChild(boardScopedStyleEl);
      }
      boardScopedStyleEl.textContent = cssText;
    }

    function _boardRendererCtx(presentation, extra) {
      return Object.assign({
        root: root,
        gridEl: gridEl,
        canvasEl: canvasEl,
        canvasInner: canvasInner,
        appearance: presentation,
        mode: mode.current,
        engine: engine,
        nodes: nodeList.slice(),
        containerEl: containerEl,
      }, extra || {});
    }

    function _resolveBoardHost(presentation) {
      _applyElementPresentation(root, 'lc-board', presentation.boardClass, '', presentation.boardStyle);
      _applyElementPresentation(gridEl, 'row g-3 lc-board-grid', presentation.listClass, '', presentation.listStyle);

      let mountEl = gridEl;
      let listEl = gridEl;
      if (boardRenderer && typeof boardRenderer.createBoardHost === 'function') {
        const custom = boardRenderer.createBoardHost(_boardRendererCtx(presentation, {
          defaultMountEl: gridEl,
          defaultListEl: gridEl,
        }));
        if (_isDomElement(custom)) {
          mountEl = custom;
          listEl = custom;
        } else if (custom && typeof custom === 'object') {
          mountEl = custom.mountEl || custom.hostEl || custom.containerEl || gridEl;
          listEl = custom.listEl || custom.contentEl || custom.mountEl || mountEl;
        }
      }

      root.innerHTML = '';
      if (mountEl !== gridEl && listEl === gridEl && !mountEl.contains(gridEl)) {
        mountEl.appendChild(gridEl);
      }
      if (mountEl !== root) {
        if (listEl !== mountEl && !_isDomElement(listEl.parentNode)) mountEl.appendChild(listEl);
        root.appendChild(mountEl);
      } else if (listEl !== root && !root.contains(listEl)) {
        root.appendChild(listEl);
      }
      return { mountEl: mountEl, listEl: listEl };
    }

    function _resolveCanvasHost(presentation) {
      _applyElementPresentation(root, 'lc-board', presentation.boardClass, '', presentation.boardStyle);
      _applyElementPresentation(canvasEl, 'lc-canvas', presentation.canvasClass, 'position:relative;overflow:auto;width:100%;', presentation.canvasStyle);
      _applyElementPresentation(canvasInner, 'lc-canvas-inner', presentation.canvasInnerClass, 'position:relative;transform-origin:0 0;min-width:100%;min-height:100%;', presentation.canvasInnerStyle);

      let mountEl = canvasEl;
      let surfaceEl = canvasEl;
      if (boardRenderer && typeof boardRenderer.createCanvasHost === 'function') {
        const custom = boardRenderer.createCanvasHost(_boardRendererCtx(presentation, {
          defaultMountEl: canvasEl,
          defaultSurfaceEl: canvasEl,
          defaultCanvasEl: canvasEl,
        }));
        if (_isDomElement(custom)) {
          mountEl = custom;
          surfaceEl = custom;
        } else if (custom && typeof custom === 'object') {
          mountEl = custom.mountEl || custom.hostEl || custom.containerEl || canvasEl;
          surfaceEl = custom.surfaceEl || custom.canvasEl || custom.mountEl || mountEl;
        }
      }

      root.innerHTML = '';
      if (mountEl !== canvasEl && surfaceEl === canvasEl && !mountEl.contains(canvasEl)) {
        mountEl.appendChild(canvasEl);
      }
      if (mountEl !== root) root.appendChild(mountEl);
      else if (surfaceEl !== root && !root.contains(surfaceEl)) root.appendChild(surfaceEl);
      return { mountEl: mountEl, surfaceEl: surfaceEl };
    }

    function _createBoardItemSlot(node, presentation, listEl) {
      const defaultClassName = 'col-12 col-md-' + _colWidth(node);
      let containerEl = document.createElement('div');
      let bodyEl = null;
      containerEl.className = defaultClassName;
      containerEl.dataset.nodeId = node.id;
      if (boardRenderer && typeof boardRenderer.createBoardItem === 'function') {
        const custom = boardRenderer.createBoardItem(node, _boardRendererCtx(presentation, {
          listEl: listEl,
          defaultClassName: defaultClassName,
          defaultContainerEl: containerEl,
        }));
        if (_isDomElement(custom)) {
          containerEl = custom;
        } else if (custom && typeof custom === 'object') {
          containerEl = custom.containerEl || custom.colEl || custom.mountEl || containerEl;
          bodyEl = custom.bodyEl || custom.contentEl || null;
        }
      }
      if (!containerEl.dataset.nodeId) containerEl.dataset.nodeId = node.id;
      if (!containerEl.className) containerEl.className = defaultClassName;
      return { containerEl: containerEl, bodyEl: bodyEl };
    }

    function _createCanvasItemSlot(node, presentation, pos) {
      const defaultClassName = 'lc-canvas-card card shadow-sm';
      let containerEl = document.createElement('div');
      let bodyEl = null;
      containerEl.className = defaultClassName;
      containerEl.dataset.nodeId = node.id;
      containerEl.style.left = pos.x + 'px';
      containerEl.style.top = pos.y + 'px';
      if (pos.w) containerEl.style.width = pos.w + 'px';
      if (pos.h) containerEl.style.height = pos.h + 'px';
      if (boardRenderer && typeof boardRenderer.createCanvasItem === 'function') {
        const custom = boardRenderer.createCanvasItem(node, _boardRendererCtx(presentation, {
          defaultClassName: defaultClassName,
          defaultContainerEl: containerEl,
          position: pos,
        }));
        if (_isDomElement(custom)) {
          containerEl = custom;
        } else if (custom && typeof custom === 'object') {
          containerEl = custom.containerEl || custom.cardEl || custom.mountEl || containerEl;
          bodyEl = custom.bodyEl || custom.contentEl || null;
        }
      }
      if (!containerEl.dataset.nodeId) containerEl.dataset.nodeId = node.id;
      if (!containerEl.className) containerEl.className = defaultClassName;
      containerEl.style.left = pos.x + 'px';
      containerEl.style.top = pos.y + 'px';
      if (pos.w) containerEl.style.width = pos.w + 'px';
      if (pos.h) containerEl.style.height = pos.h + 'px';
      return { containerEl: containerEl, bodyEl: bodyEl };
    }

    // Board/canvas CSS
    if (!document.getElementById('lc-board-css')) {
      const s = document.createElement('style');
      s.id = 'lc-board-css';
      s.textContent = `
        .lc-canvas-card { position:absolute; min-width:${cvs.minWidth}px; cursor:grab; user-select:none; z-index:1; }
        .lc-canvas-card.lc-dragging { cursor:grabbing; z-index:10; box-shadow:0 8px 24px rgba(0,0,0,0.18)!important; }
        .lc-canvas-card .card-body { overflow:hidden; }
        .lc-canvas-card.lc-resizing { cursor:nwse-resize; z-index:10; }
        .lc-resize-handle { position:absolute; bottom:0; right:0; width:14px; height:14px; cursor:nwse-resize; z-index:2; opacity:0.4; transition:opacity .15s; }
        .lc-resize-handle:hover { opacity:1; }
        .lc-resize-handle::after { content:''; position:absolute; bottom:3px; right:3px; width:8px; height:8px; border-right:2px solid var(--bs-secondary,#6c757d); border-bottom:2px solid var(--bs-secondary,#6c757d); }
        .lc-canvas-edges path.lc-edge-path { stroke:rgba(100,140,200,0.5); stroke-width:2; fill:none; stroke-linecap:round; }
        .lc-canvas-edges line { stroke:rgba(100,140,200,0.4); stroke-width:2; }
        @keyframes lc-edge-flow { to { stroke-dashoffset:-10; } }
        .lc-source-node { position:absolute; cursor:grab; user-select:none; z-index:1; }
        .lc-source-node.lc-dragging { cursor:grabbing; z-index:10; }
      `;
      document.head.appendChild(s);
    }

    // ---- Helpers ----

    function _colWidth(node) {
      const view = node && node.card ? node.card.view : null;
      if (view && view.layout && view.layout.board && view.layout.board.col) return view.layout.board.col;
      return defaultCol;
    }

    // Delegate a single view element kind to the builtin element renderer.
    function _renderBuiltin(model, kind, value, container, elemConfig) {
      const r = engine.renderers && engine.renderers[kind];
      if (!r) { container.innerHTML = '<div class="text-muted small">No builtin renderer for ' + _esc(kind) + '</div>'; return; }
      try { r(value, container, elemConfig || { kind: kind }, model); } catch (e) {
        container.innerHTML = '<div class="text-danger small">Builtin render error: ' + _esc(e && e.message) + '</div>';
      }
    }

    // Build the renderer context passed to custom card renderers.
    function _customRendererCtx(node) {
      return {
        chatState: _chatStateFromCardState(node),
        get chatMessages() { return engine.getChatStateForCard ? engine.getChatStateForCard(node.id).messages : _chatStateFromCardState(node).messages; },
        get isReceivingChats() { return engine.isReceivingChatsForCard ? engine.isReceivingChatsForCard(node.id) : !!_chatStateFromCardState(node).receiving; },
        startReceivingChats: function () { engine.startReceivingChatsForCard && engine.startReceivingChatsForCard(node.id); },
        stopReceivingChats:  function () { engine.stopReceivingChatsForCard && engine.stopReceivingChatsForCard(node.id); },
        renderBuiltin: function (m, k, v, c, ec) { _renderBuiltin(m || node, k, v, c, ec); },
        // Inline pane mounts, with cardId pinned to the current card so renderers
        // can't accidentally mount another card's pane. Delegates to the engine's
        // own mount* APIs (defined in init()'s closure).
        mountChatPane:        function (opts) { return engine.mountChatPane       (Object.assign({}, opts, { cardId: node.id })); },
        mountFilesUploadPane: function (opts) { return engine.mountFilesUploadPane(Object.assign({}, opts, { cardId: node.id })); },
        mountFilesListPane:   function (opts) { return engine.mountFilesListPane  (Object.assign({}, opts, { cardId: node.id })); },
      };
    }

    // Render a node using its custom renderer.  Returns the container element used.
    function _renderCustomCard(node, parentEl, isCanvas) {
      const rendererName = _rendererKey(node);
      const customRenderer = rendererName ? _globalRenderers[rendererName] : null;
      if (!customRenderer || !customRenderer.renderBody) return null;
      const ctx = _customRendererCtx(node);
      let shell = null;
      if (customRenderer.createShell) {
        shell = customRenderer.createShell(node, { container: parentEl, isCanvas: !!isCanvas });
        if (shell) parentEl.appendChild(shell);
      }
      const target = shell || parentEl;
      customRenderer.renderBody(node, target, ctx);
      return target;
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

    /**
     * Returns tokens this node provides.
     * Explicit: card.provides[].bindTo
     * Implicit default: the node's own id (if no provides declared)
     */
    function _getProvides(node) {
      if (!node || !node.card) return [node ? node.id : ''];
      if (Array.isArray(node.card.provides) && node.card.provides.length > 0) {
        return node.card.provides.map(function(p) { return (typeof p === 'string') ? p : (p.bindTo || p); });
      }
      // Default: node provides a token equal to its own id
      return [node.id];
    }

    /**
     * Build token → provider nodeId map from all nodes in the board.
     * Called before drawing edges so we can resolve requires tokens → source nodes.
     */
    function _buildTokenMap() {
      var map = {};
      nodeList.forEach(function(node) {
        _getProvides(node).forEach(function(token) {
          map[token] = node.id;
        });
      });
      return map;
    }

    /**
     * Resolve required tokens to provider node IDs.
     * Returns deduplicated array of source node IDs for a given consumer node.
     */
    function _resolveEdgeSources(node, tokenMap) {
      var sources = [];
      var seen = {};
      _getRequires(node).forEach(function(token) {
        var srcId = tokenMap[token];
        if (srcId && !seen[srcId]) {
          seen[srcId] = true;
          sources.push(srcId);
        }
      });
      return sources;
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
      cardSection.innerHTML = '<h6 class="fw-semibold mb-2">Card Definition (Read-only)</h6>';
      const cardDef = (node && node.card) ? node.card : {};
      cardSection.innerHTML += `<pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-wrap: break-word;">${_esc(JSON.stringify(cardDef, null, 2))}</pre>`;
      body.appendChild(cardSection);

      const computedSection = document.createElement('div');
      computedSection.className = 'mb-4';
      computedSection.innerHTML = '<h6 class="fw-semibold mb-2">Computed Values (Read-only)</h6>';
      const computedValues = node.computed_values || {};
      computedSection.innerHTML += `<pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-wrap: break-word;">${_esc(JSON.stringify(computedValues, null, 2))}</pre>`;
      body.appendChild(computedSection);

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
      const card = node && node.card ? node.card : {};
      const isSimulation = card.meta && card.meta.simulation === true;
      const isGandalfCard  = card.meta && card.meta._gandalfCard === true;
      const isRunning     = node && node.runtime_state && node.runtime_state.task_status === 'running';
      const extraClass   = isSimulation ? ' lc-simulation-card' : (isGandalfCard ? ' lc-gandalf-card' : '');
      wrap.className = 'card shadow-sm h-100' + extraClass + (isRunning ? ' lc-running' : '');
      const header = document.createElement('div');
      header.className = 'card-header d-flex align-items-center gap-2 py-2';
      const title = (card.meta && card.meta.title) || node.id;
      const tags = (card.meta && card.meta.tags) || [];
      let badgeHtml = '';
      if ((card.source_defs && card.source_defs.length) && !card.view) {
        var src = card.source_defs[0] || {};
        badgeHtml = '<span class="badge bg-info text-dark ms-auto">' + _esc(src.kind || 'source') + '</span>';
      } else if (tags.length) {
        badgeHtml = tags.map(t => '<span class="badge bg-secondary ms-1">' + _esc(t) + '</span>').join('');
      }
      header.innerHTML = '<strong class="small">' + _esc(title) + '</strong>' + badgeHtml;

      // Gandalf cards: collapsible via caret — caret gets its own click listener,
      // header is left alone for dragging in canvas mode.
      if (isGandalfCard) {
        const caret = document.createElement('span');
        caret.className = 'lc-gandalf-caret';
        caret.title = 'Collapse / expand';
        caret.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        header.appendChild(caret);

        const storageKey = 'lc-gandalf-collapsed:' + (node.id || title);
        if (sessionStorage.getItem(storageKey) === '1') {
          wrap.classList.add('lc-collapsed');
          header.dataset.gandalfCollapsed = '1';
        }

        caret.addEventListener('click', function(e) {
          e.stopPropagation();
          const cardEl = caret.closest('.lc-gandalf-card') || wrap;
          cardEl.classList.toggle('lc-collapsed');
          sessionStorage.setItem(storageKey, cardEl.classList.contains('lc-collapsed') ? '1' : '0');
        });
        caret.addEventListener('pointerdown', e => e.stopPropagation()); // prevent drag start
      }
      if (isSimulation) {
        const simBtns = document.createElement('span');
        simBtns.className = 'd-inline-flex align-items-center gap-1 ms-auto';

        const pinBtn = document.createElement('button');
        pinBtn.className = 'btn btn-sm btn-outline-success lc-sim-pin';
        pinBtn.style.cssText = 'padding: 2px 6px;';
        pinBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 2h6l-1 7h-4L9 2z"/><path d="M6 17h12l-2-4H8L6 17z"/></svg>';
        pinBtn.title = 'Pin this simulation card';
        pinBtn.dataset.nodeId = node.id;

        const discardBtn = document.createElement('button');
        discardBtn.className = 'btn btn-sm btn-outline-danger lc-sim-discard';
        discardBtn.style.cssText = 'padding: 2px 6px;';
        discardBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        discardBtn.title = 'Discard this simulation card';
        discardBtn.dataset.nodeId = node.id;

        simBtns.appendChild(pinBtn);
        simBtns.appendChild(discardBtn);
        header.appendChild(simBtns);
      }

      // Add dev mode code icon button if devMode is enabled
      if (devMode.current) {
        const codeBtn = document.createElement('button');
        codeBtn.className = 'btn btn-sm btn-outline-secondary';
        codeBtn.style.cssText = 'padding: 2px 6px;' + (isSimulation ? '' : ' margin-left: auto;');
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

      // Token gem rows — requires gems above header, provides gems below body
      const requiresTokens = (card.requires && Array.isArray(card.requires)) ? card.requires : [];
      const providesTokens = (Array.isArray(card.provides) && card.provides.length)
        ? card.provides.map(function(p) { return typeof p === 'string' ? p : (p.bindTo || p); })
        : [node.id];

      // Requires gems — top of card (above header)
      if (requiresTokens.length) {
        const reqRow = document.createElement('div');
        reqRow.className = 'lc-token-row lc-token-row-requires';
        requiresTokens.forEach(function(token) {
          const gem = document.createElement('span');
          gem.className = 'lc-token-gem lc-token-gem-requires';
          gem.dataset.token = token;
          gem.title = token;
          reqRow.appendChild(gem);
        });
        wrap.appendChild(reqRow);
      }

      wrap.appendChild(header);
      wrap.appendChild(body);

      // Provides gems — bottom of card (below body)
      if (providesTokens.length) {
        const provRow = document.createElement('div');
        provRow.className = 'lc-token-row lc-token-row-provides';
        providesTokens.forEach(function(token) {
          const gem = document.createElement('span');
          gem.className = 'lc-token-gem lc-token-gem-provides';
          gem.dataset.token = token;
          gem.title = token;
          provRow.appendChild(gem);
        });
        wrap.appendChild(provRow);
      }

      return { wrap, header, body };
    }

    function _buildSourcePill(node) {
      const el = document.createElement('div');
      el.className = 'lc-source-node';
      const status = (node.card_data && node.card_data.status) || 'fresh';
      const card = node && node.card ? node.card : {};
      const title = (card.meta && card.meta.title) || node.id;
      const kind = (card.source_defs && card.source_defs[0] && card.source_defs[0].kind) || 'source';
      el.innerHTML = `<div class="lc-source-pill shadow-sm">
        ${_statusDot(status)}
        <span class="fw-medium">${_esc(title)}</span>
        <span class="badge bg-info text-dark">${_esc(kind)}</span>
      </div>`;
      return el;
    }

    // ---- Board mode ----

    // Compute canvas inner size from card positions + padding
    function _fitCanvasToContent() {
      var pad = 100;
      var maxR = 0, maxB = 0;
      canvasInner.querySelectorAll('.lc-canvas-card,.lc-source-node').forEach(function(el) {
        var r = el.offsetLeft + el.offsetWidth;
        var b = el.offsetTop + el.offsetHeight;
        if (r > maxR) maxR = r;
        if (b > maxB) maxB = b;
      });
      canvasInner.style.width = (maxR + pad) + 'px';
      canvasInner.style.height = (maxB + pad) + 'px';
    }

    function _renderBoard() {
      const presentation = _currentBoardPresentation();
      _syncBoardScopedStyles(presentation);
      _destroyEdges();
      document.body.style.overflow = '';
      const boardHost = _resolveBoardHost(presentation);
      _lastBoardHost = boardHost;
      boardHost.listEl.innerHTML = '';

      // Only card nodes in board mode, sorted by order
      const cards = nodeList.filter(n => n.card && n.card.view).slice();
      cards.sort((a, b) => {
        const ao = (a.card && a.card.view && a.card.view.layout && a.card.view.layout.board && a.card.view.layout.board.order) || 0;
        const bo = (b.card && b.card.view && b.card.view.layout && b.card.view.layout.board && b.card.view.layout.board.order) || 0;
        return ao - bo;
      });

      cards.forEach(node => {
        const slot = _createBoardItemSlot(node, presentation, boardHost.listEl);
        const col = slot.containerEl;

        const rendererName = _rendererKey(node);
        const customRenderer = rendererName ? _globalRenderers[rendererName] : null;
        if (customRenderer && customRenderer.renderBody) {
          boardHost.listEl.appendChild(col);
          const bodyEl = _renderCustomCard(node, slot.bodyEl || col, false);
          nodeMap[node.id] = { node, colEl: col, bodyEl: bodyEl || col, isCustom: true };
        } else {
          const { wrap, body } = _buildCardWrapper(node);
          (slot.bodyEl || col).appendChild(wrap);
          boardHost.listEl.appendChild(col);
          nodeMap[node.id] = { node, colEl: col, bodyEl: body };
          engine.render(node, body, { showChat });
        }
      });
      _updateTokenAvailability();
      if (boardRenderer && typeof boardRenderer.afterRenderBoard === 'function') {
        boardRenderer.afterRenderBoard(_boardRendererCtx(presentation, {
          mountEl: boardHost.mountEl,
          listEl: boardHost.listEl,
          cards: cards.slice(),
          nodeMap: nodeMap,
        }));
      }
    }

    // ---- Canvas mode ----

    function _applyTransform() {
      canvasInner.style.transform = `translate(${cvs.panX}px,${cvs.panY}px) scale(${cvs.zoom})`;
    }

    /**
     * Update token badge availability: a provides badge turns green when the
     * node has data; a requires badge turns green when the upstream provider
     * has data for that token.
     */
    function _updateTokenAvailability() {
      var tokenMap = _buildTokenMap();
      // A node "has data" when card_data or computed_values is non-empty, or status is fresh/completed.
      var nodeHasData = {};
      nodeList.forEach(function(node) {
        var cd = node.card_data || (node.card && node.card.card_data);
        var cv = node.computed_values;
        var status = cd && cd.status;
        var hasOutput = (cd && Object.keys(cd).length > 0) || (cv && Object.keys(cv).length > 0);
        nodeHasData[node.id] = hasOutput || status === 'fresh' || status === 'completed';
      });

      // Update all gem elements in root container
      var allGems = root.querySelectorAll('.lc-token-gem');
      allGems.forEach(function(gem) {
        var token = gem.dataset.token;
        if (!token) return;
        if (gem.classList.contains('lc-token-gem-provides')) {
          // The provides gem: green if this node has data
          var nodeEl = gem.closest('[data-node-id]');
          var nId = nodeEl && nodeEl.dataset.nodeId;
          gem.classList.toggle('lc-token-available', !!(nId && nodeHasData[nId]));
        } else if (gem.classList.contains('lc-token-gem-requires')) {
          // The requires gem: green if the upstream provider for this token has data
          var srcId = tokenMap[token];
          gem.classList.toggle('lc-token-available', !!(srcId && nodeHasData[srcId]));
        }
      });
    }

    function _destroyEdges() {
      _edges.forEach(function(line) { try { line.remove(); } catch(e) { /* noop */ } });
      _edges.length = 0;
    }

    function _repositionEdges() {
      _edges.forEach(function(line) { try { line.position(); } catch(e) { /* noop */ } });
    }

    function _drawEdges() {
      _destroyEdges();
      svgEl.querySelectorAll('line,path').forEach(function(el) { el.remove(); });
      if (!cvs.edges) return;

      // Build token → provider nodeId map
      var tokenMap = _buildTokenMap();

      // SVG edges — rendered behind cards (z-index:0) for a clean look
      nodeList.forEach(function(node) {
        var tgtInfo = nodeMap[node.id];
        if (!tgtInfo || !tgtInfo.colEl) return;
        _getRequires(node).forEach(function(token) {
          var srcId = tokenMap[token];
          if (!srcId) return;
          var srcInfo = nodeMap[srcId];
          if (!srcInfo || !srcInfo.colEl) return;
          // Locate gems; fall back to card element if gem not found
          var srcGem = srcInfo.colEl.querySelector('.lc-token-gem-provides[data-token="' + token + '"]');
          var tgtGem = tgtInfo.colEl.querySelector('.lc-token-gem-requires[data-token="' + token + '"]');
          var sx, sy, tx, ty;
          var innerRect = canvasInner.getBoundingClientRect();
          if (srcGem) {
            var srcRect = srcGem.getBoundingClientRect();
            sx = (srcRect.left + srcRect.width / 2 - innerRect.left) / cvs.zoom;
            sy = (srcRect.bottom - innerRect.top) / cvs.zoom;
          } else {
            var sEl = srcInfo.colEl;
            sx = sEl.offsetLeft + sEl.offsetWidth / 2;
            sy = sEl.offsetTop + sEl.offsetHeight;
          }
          if (tgtGem) {
            var tgtRect = tgtGem.getBoundingClientRect();
            tx = (tgtRect.left + tgtRect.width / 2 - innerRect.left) / cvs.zoom;
            ty = (tgtRect.top - innerRect.top) / cvs.zoom;
          } else {
            var tEl = tgtInfo.colEl;
            tx = tEl.offsetLeft + tEl.offsetWidth / 2;
            ty = tEl.offsetTop;
          }
          // Route bezier curves around cards — offset control points outward
          var dx = tx - sx;
          var dy = ty - sy;
          var dist = Math.sqrt(dx * dx + dy * dy);
          var cpLen = Math.max(40, Math.min(dist * 0.4, 120));
          // Determine if src is roughly above, below, left, or right of target
          var absDx = Math.abs(dx);
          var absDy = Math.abs(dy);
          var cp1x, cp1y, cp2x, cp2y;
          if (absDy > absDx * 0.4) {
            // Mostly vertical — curve control points go straight down/up
            cp1x = sx; cp1y = sy + cpLen;
            cp2x = tx; cp2y = ty - cpLen;
          } else {
            // Mostly horizontal — swing control points outward to avoid overlapping cards
            var sideSign = dx > 0 ? 1 : -1;
            cp1x = sx + sideSign * cpLen; cp1y = sy + cpLen * 0.5;
            cp2x = tx - sideSign * cpLen; cp2y = ty - cpLen * 0.5;
          }
          var d = 'M ' + sx + ' ' + sy + ' C ' + cp1x + ' ' + cp1y + ', ' + cp2x + ' ' + cp2y + ', ' + tx + ' ' + ty;
          var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('fill', 'none');
          path.setAttribute('marker-end', 'url(#lc-arrow)');
          path.classList.add('lc-edge-path');
          svgEl.appendChild(path);
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
        if (_edges.length) _repositionEdges();
        else _drawEdges();
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
        _fitCanvasToContent();
        if (_edges.length) _repositionEdges();
        else _drawEdges();
      }, { signal });
    }

    function _makeResizable(el, node) {
      const handle = document.createElement('div');
      handle.className = 'lc-resize-handle';
      el.appendChild(handle);
      el.style.overflow = 'visible';

      let resizing = false, startX, startY, origW, origH;

      handle.addEventListener('pointerdown', function(e) {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        resizing = true;
        el.classList.add('lc-resizing');
        handle.setPointerCapture(e.pointerId);
        startX = e.clientX;
        startY = e.clientY;
        origW = el.offsetWidth;
        origH = el.offsetHeight;
      }, { signal });

      handle.addEventListener('pointermove', function(e) {
        if (!resizing) return;
        const dw = (e.clientX - startX) / cvs.zoom;
        const dh = (e.clientY - startY) / cvs.zoom;
        const newW = Math.max(cvs.minWidth, origW + dw);
        const newH = Math.max(80, origH + dh);
        el.style.width = newW + 'px';
        el.style.height = newH + 'px';
        if (_edges.length) _repositionEdges();
        else _drawEdges();
      }, { signal });

      handle.addEventListener('pointerup', function() {
        if (!resizing) return;
        resizing = false;
        el.classList.remove('lc-resizing');
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        // Snap to grid
        const sw = cvs.snap > 1 ? Math.round(w / cvs.snap) * cvs.snap : w;
        const sh = cvs.snap > 1 ? Math.round(h / cvs.snap) * cvs.snap : h;
        el.style.width = sw + 'px';
        el.style.height = sh + 'px';
        // Persist dimensions
        _positions[node.id] = Object.assign(_positions[node.id] || {}, { w: sw, h: sh });
        if (node.card && node.card.view) {
          if (!node.card.view.layout) node.card.view.layout = {};
          if (!node.card.view.layout.canvas) node.card.view.layout.canvas = {};
          node.card.view.layout.canvas.w = sw;
          node.card.view.layout.canvas.h = sh;
        }
        engine.notify(node.id);
        _fitCanvasToContent();
        if (_edges.length) _repositionEdges();
        else _drawEdges();
      }, { signal });
    }

    function _renderCanvas() {
      const presentation = _currentBoardPresentation();
      _syncBoardScopedStyles(presentation);
      _destroyEdges();
      document.body.style.overflow = 'hidden';
      const canvasHost = _resolveCanvasHost(presentation);
      // Fill remaining viewport height
      var top = canvasEl.getBoundingClientRect().top;
      canvasEl.style.height = co.height || ('calc(100vh - ' + top + 'px)');
      canvasInner.querySelectorAll('.lc-canvas-card,.lc-source-node').forEach(el => el.remove());
      svgEl.querySelectorAll('line,path').forEach(function(el) { el.remove(); });
      _initPositions();
      _applyTransform();

      nodeList.forEach(node => {
        const pos = _positions[node.id] || { x: 0, y: 0 };

        if ((!node.card || !node.card.view) && (node.card && node.card.source_defs && node.card.source_defs.length)) {
          const el = _buildSourcePill(node);
          el.dataset.nodeId = node.id;
          el.style.left = pos.x + 'px';
          el.style.top  = pos.y + 'px';
          canvasInner.appendChild(el);
          nodeMap[node.id] = { node, colEl: el, bodyEl: null };
          _makeDraggable(el, node);
        } else {
          const slot = _createCanvasItemSlot(node, presentation, pos);
          const el = slot.containerEl;
          const isSimCanvas   = node.card && node.card.meta && node.card.meta.simulation === true;
          const isGandalfCanvas = node.card && node.card.meta && node.card.meta._gandalfCard === true;
          const canvasExtra   = isSimCanvas ? ' lc-simulation-card' : (isGandalfCanvas ? ' lc-gandalf-card' : '');
          el.className = _joinClasses(el.className || 'lc-canvas-card card shadow-sm', canvasExtra);

          const rendererName = _rendererKey(node);
          const customRenderer = rendererName ? _globalRenderers[rendererName] : null;
          if (customRenderer && customRenderer.renderBody) {
            canvasInner.appendChild(el);
            const bodyEl = _renderCustomCard(node, slot.bodyEl || el, true);
            nodeMap[node.id] = { node, colEl: el, bodyEl: bodyEl || el, isCustom: true };
          } else {
            const { wrap, body } = _buildCardWrapper(node);
            const targetEl = slot.bodyEl || el;
            while (wrap.firstChild) targetEl.appendChild(wrap.firstChild);
            // Re-apply collapsed state: in canvas mode el is the card container, not wrap
            const movedHeader = el.querySelector('.card-header');
            if (movedHeader && movedHeader.dataset.gandalfCollapsed === '1') el.classList.add('lc-collapsed');
            canvasInner.appendChild(el);
            nodeMap[node.id] = { node, colEl: el, bodyEl: body };
            engine.render(node, body, { showChat: false });
          }
          _makeDraggable(el, node);
          _makeResizable(el, node);
        }
      });

      _updateTokenAvailability();

      // Fit canvas to content then draw edges
      requestAnimationFrame(function() {
        _fitCanvasToContent();
        _drawEdges();
      });
      if (boardRenderer && typeof boardRenderer.afterRenderCanvas === 'function') {
        boardRenderer.afterRenderCanvas(_boardRendererCtx(presentation, {
          mountEl: canvasHost.mountEl,
          surfaceEl: canvasHost.surfaceEl,
          nodeMap: nodeMap,
        }));
      }

      // Reposition LeaderLine edges on scroll
      canvasEl.addEventListener('scroll', function() { _repositionEdges(); }, { signal, passive: true });

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
        _repositionEdges();
      }, { signal });
      canvasEl.addEventListener('pointerup', () => { panning = false; }, { signal });

      // Zoom: Ctrl+wheel
      canvasEl.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        cvs.zoom = Math.min(cvs.zoomMax, Math.max(cvs.zoomMin, cvs.zoom * delta));
        _applyTransform();
        _repositionEdges();
      }, { signal, passive: false });
    }

    function _render() {
      if (mode.current === 'canvas') _renderCanvas();
      else _renderBoard();
    }

    // ---- Auto-layout (topological L → R) ----

    function autoLayout() {
      const tokenMap = _buildTokenMap();
      const incoming = {};
      const levels = {};
      nodeList.forEach(n => { incoming[n.id] = []; levels[n.id] = 0; });
      nodeList.forEach(n => {
        _resolveEdgeSources(n, tokenMap).forEach(srcId => {
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

    /**
     * Per-node update: replace runtime fields on the existing node object in place
     * and re-render only that node's body. Outer wrapper is rebuilt to pick up
     * status/badges, but the surrounding column element is reused so layout is stable.
     * Editable element state is preserved via journal overlays keyed by nodeId:bindPath.
     */
    function updateNode(id, model) {
      const entry = nodeMap[id];
      if (!entry) throw new Error('updateNode: unknown node id ' + id);
      const node = entry.node;
      if (model && typeof model === 'object') {
        if (model.card !== undefined) node.card = model.card;
        if (model.card_data !== undefined) node.card_data = model.card_data;
        if (model.requires !== undefined) node.requires = model.requires;
        if (model.computed_values !== undefined) node.computed_values = model.computed_values;
        if (model.runtime_state !== undefined) node.runtime_state = model.runtime_state;
        if (model.card_chats !== undefined) node.card_chats = model.card_chats;
      }
      engine.destroy(id);
      const rendererName = _rendererKey(node);
      const customRenderer = rendererName ? _globalRenderers[rendererName] : null;
      if (customRenderer && customRenderer.renderBody) {
        const colEl = entry.colEl;
        colEl.innerHTML = '';
        const bodyEl = _renderCustomCard(node, colEl, mode.current === 'canvas');
        nodeMap[id] = { node, colEl, bodyEl: bodyEl || colEl, isCustom: true };
      } else if (mode.current === 'board') {
        const colEl = entry.colEl;
        colEl.innerHTML = '';
        const built = _buildCardWrapper(node);
        colEl.appendChild(built.wrap);
        nodeMap[id] = { node, colEl, bodyEl: built.body };
        engine.render(node, built.body, { showChat });
      } else {
        const el = entry.colEl;
        el.innerHTML = '';
        const built = _buildCardWrapper(node);
        while (built.wrap.firstChild) el.appendChild(built.wrap.firstChild);
        nodeMap[id] = { node, colEl: el, bodyEl: built.body };
        engine.render(node, built.body, { showChat: false });
      }
      _updateTokenAvailability();
    }

    function clear() {
      _destroyEdges();
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
      _destroyEdges();
      document.body.style.overflow = '';
      ac.abort();
      if (boardScopedStyleEl && boardScopedStyleEl.parentNode) boardScopedStyleEl.parentNode.removeChild(boardScopedStyleEl);
      boardScopedStyleEl = null;
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
      updateNode,
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
  // Board — reactive host. State in, view out. No destructive re-renders.
  // ===========================================================================

  function Board(engine, containerEl, opts) {
    opts = opts || {};
    const initialState = opts.initialState;
    const getNodeIds = opts.getNodeIds;
    const selectNode = opts.selectNode;
    if (typeof getNodeIds !== 'function' || typeof selectNode !== 'function') {
      throw new Error('LiveCard.Board requires getNodeIds and selectNode functions');
    }

    let state = initialState;
    const prevModelsById = {};
    const prevFingerprintsById = {};

    function _stableStringify(v) {
      if (v == null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return '[' + v.map(_stableStringify).join(',') + ']';
      const keys = Object.keys(v).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + _stableStringify(v[k])).join(',') + '}';
    }

    function _modelFingerprint(model) {
      if (!model || typeof model !== 'object') return 'null';
      return _stableStringify({
        card: model.card,
        card_data: model.card_data,
        requires: model.requires,
        computed_values: model.computed_values,
        runtime_state: model.runtime_state,
        card_chats: model.card_chats,
      });
    }

    const initialIds = getNodeIds(state);
    const initialNodes = initialIds.map(id => {
      const m = selectNode(state, id);
      prevModelsById[id] = m;
      prevFingerprintsById[id] = _modelFingerprint(m);
      return m;
    });

    const coreOpts = {};
    Object.keys(opts).forEach(k => {
      if (k === 'initialState' || k === 'getNodeIds' || k === 'selectNode' || k === 'nodes') return;
      coreOpts[k] = opts[k];
    });
    coreOpts.nodes = initialNodes;

    const core = BoardCore(engine, containerEl, coreOpts);

    function _changed(prevFingerprint, nextFingerprint) {
      return prevFingerprint !== nextFingerprint;
    }

    function setState(nextStateOrUpdater) {
      const nextState = (typeof nextStateOrUpdater === 'function')
        ? nextStateOrUpdater(state)
        : nextStateOrUpdater;
      if (nextState === undefined) return;

      state = nextState;
      const nextIds = getNodeIds(state);
      const nextSet = new Set(nextIds);

      // Removals
      Object.keys(prevModelsById).forEach(id => {
        if (!nextSet.has(id)) {
          core.remove(id);
          delete prevModelsById[id];
          delete prevFingerprintsById[id];
        }
      });

      // Additions and per-node updates
      nextIds.forEach(id => {
        const next = selectNode(state, id);
        const prev = prevModelsById[id];
        const nextFingerprint = _modelFingerprint(next);
        const prevFingerprint = prevFingerprintsById[id];
        if (!prev) {
          core.add(next);
        } else if (_changed(prevFingerprint, nextFingerprint)) {
          core.updateNode(id, next);
        }
        prevModelsById[id] = next;
        prevFingerprintsById[id] = nextFingerprint;
      });

      // Reorder if id sequence differs
      const currentOrder = core.nodes.map(n => n.id);
      const orderDiffers = nextIds.length !== currentOrder.length
        || nextIds.some((id, i) => id !== currentOrder[i]);
      if (orderDiffers) core.reorder(nextIds);
    }

    function destroy() {
      Object.keys(prevModelsById).forEach(k => delete prevModelsById[k]);
      Object.keys(prevFingerprintsById).forEach(k => delete prevFingerprintsById[k]);
      core.destroy();
    }

    return {
      setState,
      destroy,
      core,
      get state() { return state; },
    };
  }

  // ===========================================================================
  // Module export
  // ===========================================================================

  return { init, Board, BoardCore, registerCardRenderer, registerBoardTheme, registerBoardRenderer };
})();
export default LiveCard;
