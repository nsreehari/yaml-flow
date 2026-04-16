// ingest.js — Ingest engine: composable batch UI
//
// Two composables (all require opts.apiBase — no defaults):
//
//   1. IngestUI.pane(containerEl, opts) — full ingest pane with all batches (new + existing)
//      opts.apiBase       — REQUIRED. API prefix, e.g. '/api' or '/api/repo/finbook-data'
//      opts.compact       — smaller dropzone (default: false)
//      opts.layout        — 'grid' (card grid, default) or 'stack' (vertical stack)
//      opts.onBatchChange — callback(batches) when any batch state changes
//      Returns: { destroy(), refresh() }
//
//   2. IngestUI.mount(containerEl, opts) — single-batch UI (lower-level)
//      opts.apiBase       — REQUIRED. API prefix.
//      (see mount() for remaining opts)
//
// Backward compat: loadBatches() delegates to IngestUI.pane('#ingestContainer', { apiBase: '/api/repo/' + ACTIVE_REPO_ID })
//
// All API calls route through apiBase — zero hardcoded paths.
// Multi-repo = different apiBase per pane instance.

// ---- Shared constants ----
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.csv', '.md', '.json', '.html', '.xml',
  '.pdf', '.xlsx', '.docx', '.pptx',
  '.png', '.jpg', '.jpeg'
]);

// ---- Composable ingest UI ----
// eslint-disable-next-line no-unused-vars
var IngestUI = {
  /**
   * Mount a complete ingest interface (chat + dropzone + send + confirm) into a container.
   * @param {HTMLElement} containerEl — target DOM element
   * @param {object} opts — see header comment
   * @returns {{ destroy: Function, getBatchId: Function }}
   */
  mount: function(containerEl, opts) {
    opts = opts || {};
    if (!opts.apiBase) throw new Error('IngestUI.mount: opts.apiBase is required');
    var apiBase = opts.apiBase.replace(/\/$/, '');
    var apiFn = function(path) { return apiBase + path; };
    var batchId = opts.batchId || (opts.batch && opts.batch.id) || null;
    var batch = opts.batch || null;
    var showConfirm = opts.showConfirm !== false;
    var compact = opts.compact || false;
    var uid = 'iu-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);

    var isActive = !batch || batch.status === 'ready' || batch.status === 'open-items';
    var isConfirmed = batch && batch.status === 'confirmed';

    // Build HTML
    var dropZoneClass = compact ? 'drop-zone drop-zone-sm' : 'drop-zone';
    var dropZoneContent = compact
      ? '<div class="small text-muted">+ Drop files</div>'
      : '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-muted mb-2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><div class="small text-muted">Drop files here or click to browse</div>';

    var html = '<div class="ingest-ui d-flex flex-column h-100">';
    html += '<div class="chat-messages flex-grow-1 mb-2" id="' + uid + '-chat"></div>';

    if (isActive) {
      html += '<div class="batch-input-bar">';
      html += '<div class="' + dropZoneClass + ' mb-2" id="' + uid + '-drop">' + dropZoneContent;
      html += '<input type="file" id="' + uid + '-file" multiple class="d-none" accept=".txt,.csv,.md,.json,.html,.xml,.pdf,.xlsx,.docx,.pptx,.png,.jpg,.jpeg">';
      html += '</div>';
      html += '<div id="' + uid + '-staged"></div>';
      html += '<div class="input-group input-group-sm">';
      html += '<input type="text" id="' + uid + '-input" class="form-control" placeholder="Add files or type a message...">';
      html += '<button id="' + uid + '-send" class="btn btn-outline-primary" type="button">';
      html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
      html += '</button></div></div>';
      if (showConfirm) {
        html += '<div class="batch-actions d-flex gap-2 mt-2">';
        html += '<button id="' + uid + '-confirm" class="btn btn-success btn-sm"' + ((!batch || batch.status !== 'ready' || batch.processing) ? ' disabled' : '') + '>';
        html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Confirm &amp; Merge</button>';
        html += '<button id="' + uid + '-discard" class="btn btn-outline-danger btn-sm">';
        html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Discard</button>';
        html += '</div>';
      }
    } else if (isConfirmed && batch.chatCount > 0) {
      html += '<span class="badge bg-secondary" id="' + uid + '-chatpill" role="button">💬 ' + batch.chatCount + ' message(s)</span>';
    }
    html += '</div>';

    containerEl.innerHTML = html;

    var chatId = uid + '-chat';

    // Populate existing chat
    if (batch && batch.chat && batch.chat.length > 0) {
      for (var i = 0; i < batch.chat.length; i++) appendChat(chatId, batch.chat[i].role, batch.chat[i].text);
    }

    if (!isActive) {
      // Confirmed batch: wire chat pill modal
      var chatPill = document.getElementById(uid + '-chatpill');
      if (chatPill) {
        chatPill.addEventListener('click', async function() {
          chatPill.textContent = '💬 Loading...';
          try {
            var msgs = await fetch(apiFn('/batch/' + batchId + '/chat')).then(function(r) { return r.json(); });
            showChatModal(batchId, msgs);
          } catch (e) { alert('Failed to load chat'); }
          chatPill.textContent = '💬 ' + (batch.chatCount || 0) + ' message(s)';
        });
      }
      return { destroy: function() { containerEl.innerHTML = ''; }, getBatchId: function() { return batchId; } };
    }

    // Wire active batch UI
    var dropZone = document.getElementById(uid + '-drop');
    var fileInput = document.getElementById(uid + '-file');
    var stagedContainer = document.getElementById(uid + '-staged');
    var chatInput = document.getElementById(uid + '-input');
    var sendBtn = document.getElementById(uid + '-send');
    var confirmBtn = document.getElementById(uid + '-confirm');
    var discardBtn = document.getElementById(uid + '-discard');

    var updateSendState = function() {
      if (sendBtn) sendBtn.disabled = staging.getFiles().length === 0 && !chatInput.value.trim();
    };

    var staging = createFileStagingUI(dropZone, fileInput, stagedContainer, chatInput, updateSendState);
    if (sendBtn) sendBtn.disabled = true;

    var doSend = async function() {
      var resultId = await unifiedSend(batchId, staging, chatInput, sendBtn, dropZone, chatId, confirmBtn, apiFn);
      if (resultId && !batchId) {
        batchId = resultId;
        if (opts.onBatchCreated) opts.onBatchCreated(batchId);
      }
    };

    if (sendBtn) sendBtn.addEventListener('click', doSend);
    if (chatInput) {
      chatInput.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !sendBtn.disabled) doSend(); });
      chatInput.addEventListener('input', updateSendState);
    }

    // Confirm
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async function() {
        confirmBtn.disabled = true;
        try {
          var resp = await fetch(apiFn('/batch/' + batchId + '/confirm'), { method: 'POST' });
          if (!resp.ok) {
            var err = await resp.json();
            appendChat(chatId, 'system', err.error || 'Confirm failed');
            confirmBtn.disabled = false;
            return;
          }
          appendChat(chatId, 'system', 'Confirming and merging...');
          connectSSE(batchId, chatId, sendBtn, chatInput, dropZone, confirmBtn, apiFn);
          if (opts.onConfirmed) opts.onConfirmed(batchId);
        } catch (e) {
          appendChat(chatId, 'system', 'Confirm failed: ' + e.message);
          confirmBtn.disabled = false;
        }
      });
    }

    // Discard
    if (discardBtn) {
      discardBtn.addEventListener('click', async function() {
        if (!confirm('Discard batch ' + (batchId || '') + '? This will delete the branch and all changes.')) return;
        discardBtn.disabled = true;
        try {
          await fetch(apiFn('/batch/' + batchId + '/discard'), { method: 'POST' });
          if (opts.onDiscarded) opts.onDiscarded(batchId);
        } catch (e) { discardBtn.disabled = false; }
      });
    }

    // If batch is processing, show spinner and connect SSE
    if (batch && batch.processing) {
      showProcessingIndicator(chatId);
      if (confirmBtn) confirmBtn.disabled = true;
      connectSSE(batchId, chatId, sendBtn, chatInput, dropZone, confirmBtn, apiFn);
    }

    return {
      destroy: function() { containerEl.innerHTML = ''; },
      getBatchId: function() { return batchId; }
    };
  },

  /**
   * Mount a full ingest pane (all batches: new + active + confirmed) into a container.
   * Self-contained: manages its own state, fetch, render, SSE, polling.
   * @param {HTMLElement} containerEl — target DOM element
   * @param {object} opts — { apiBase, compact, layout, onBatchChange }
   * @returns {{ destroy: Function, refresh: Function }}
   */
  pane: function(containerEl, opts) {
    opts = opts || {};
    if (!opts.apiBase) throw new Error('IngestUI.pane: opts.apiBase is required');
    var apiBase = opts.apiBase.replace(/\/$/, '');
    var compact = opts.compact || false;
    var layout = opts.layout || 'grid';
    var onBatchChange = opts.onBatchChange || null;
    var batches = [];
    var pollId = null;
    var destroyed = false;
    var uid = 'ip-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);

    function api(path) { return apiBase + path; }

    function refresh() {
      if (destroyed) return;
      return fetch(api('/batches'))
        .then(function(r) { return r.ok ? r.json() : []; })
        .then(function(data) {
          batches = data;
          render();
          if (onBatchChange) onBatchChange(batches);
        })
        .catch(function(e) { console.error('IngestUI.pane: load failed', e); });
    }

    function render() {
      if (destroyed || !containerEl) return;
      if (pollId) { clearInterval(pollId); pollId = null; }

      var hasActive = batches.some(function(b) { return b.status === 'ready' || b.status === 'open-items'; });
      var layoutClass = layout === 'stack' ? '' : 'row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3';
      var html = '<div class="' + layoutClass + '">';
      if (!hasActive) html += renderPaneNewCard(uid, compact);
      for (var i = 0; i < batches.length; i++) {
        html += renderPaneBatchCard(batches[i], uid, compact);
      }
      html += '</div>';
      containerEl.innerHTML = html;

      if (!hasActive) wirePaneNewCard(uid, compact);
      for (var j = 0; j < batches.length; j++) {
        wirePaneBatchCard(batches[j], uid);
      }

      var hasProcessing = batches.some(function(b) { return b.processing; });
      if (hasProcessing) {
        pollId = setInterval(function() { refresh(); }, 3000);
      }
    }

    // ---- New Batch Card ----
    function renderPaneNewCard(puid, isCompact) {
      var dzClass = isCompact ? 'drop-zone drop-zone-sm' : 'drop-zone';
      var dzContent = isCompact
        ? '<div class="small text-muted">+ Drop files</div>'
        : '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-muted mb-2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><div class="small text-muted">Drop files here or click to browse</div>';
      return '<div class="col"><div class="card h-100 border-primary" id="' + puid + '-newCard">' +
        '<div class="card-header bg-primary text-white d-flex align-items-center gap-2">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New Batch</div>' +
        '<div class="card-body d-flex flex-column">' +
        '<div id="' + puid + '-newChat" class="chat-messages flex-grow-1 mb-2"></div>' +
        '<div class="batch-input-bar">' +
        '<div class="' + dzClass + ' mb-2" id="' + puid + '-newDrop">' + dzContent +
        '<input type="file" id="' + puid + '-newFile" multiple class="d-none" accept=".txt,.csv,.md,.json,.html,.xml,.pdf,.xlsx,.docx,.pptx,.png,.jpg,.jpeg"></div>' +
        '<div id="' + puid + '-newStaged"></div>' +
        '<div class="input-group input-group-sm">' +
        '<input type="text" id="' + puid + '-newInput" class="form-control" placeholder="Add files or type a message...">' +
        '<button id="' + puid + '-newSend" class="btn btn-outline-primary" type="button">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
        '</button></div></div></div></div></div>';
    }

    function wirePaneNewCard(puid) {
      var drop = document.getElementById(puid + '-newDrop');
      var fileIn = document.getElementById(puid + '-newFile');
      var staged = document.getElementById(puid + '-newStaged');
      var input = document.getElementById(puid + '-newInput');
      var sendBtn = document.getElementById(puid + '-newSend');
      if (!drop || !fileIn) return;

      var updateSendState = function() {
        sendBtn.disabled = staging.getFiles().length === 0 && !input.value.trim();
      };
      var staging = createFileStagingUI(drop, fileIn, staged, input, updateSendState);
      sendBtn.disabled = true;
      var activeBatchId = null;

      var doSend = async function() {
        var resultId = await unifiedSend(activeBatchId, staging, input, sendBtn, drop, puid + '-newChat', null, api);
        if (resultId) activeBatchId = resultId;
      };
      sendBtn.addEventListener('click', doSend);
      input.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !sendBtn.disabled) doSend(); });
      input.addEventListener('input', updateSendState);
    }

    // ---- Existing Batch Card ----
    function renderPaneBatchCard(batch, puid, isCompact) {
      var isConfirmed = batch.status === 'confirmed';
      var statusBadge = isConfirmed
        ? '<span class="badge bg-success">Confirmed</span>'
        : batch.status === 'open-items'
          ? '<span class="badge bg-warning text-dark">Open Items</span>'
          : '<span class="badge bg-info">Ready</span>';  

      var filesHtml = (batch.files || []).map(function(f) {
        return '<a href="' + api('/batch/' + batch.id + '/files/' + encodeURIComponent(f)) + '" class="batch-file-link d-flex align-items-center gap-1 small" target="_blank" download>' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          escapeHtml(f) + '</a>';
      }).join('');

      var decisionsHtml = batch.decisions && batch.decisions.length > 0
        ? '<div class="mt-2"><span class="badge bg-secondary ' + puid + '-decisions-pill" data-batch="' + batch.id + '" role="button" tabindex="0">' +
          batch.decisions.length + ' decision(s) resolved</span>' +
          '<div class="decisions-popover d-none" id="' + puid + '-decisions-' + batch.id + '">' +
          '<div class="small">' + batch.decisions.map(function(d) { return escapeHtml(d); }).join('<hr>') + '</div></div></div>'
        : '';

      var isActive = batch.status === 'ready' || batch.status === 'open-items';
      var dzClass = isCompact ? 'drop-zone drop-zone-sm' : 'drop-zone drop-zone-sm';

      var activeHtml = '';
      if (isActive) {
        activeHtml = '<div class="batch-active-layout d-flex flex-column">' +
          '<div class="chat-messages flex-grow-1 mb-2" id="' + puid + '-batchChat-' + batch.id + '"></div>' +
          '<div class="batch-input-bar">' +
          '<div class="' + dzClass + ' mb-2" id="' + puid + '-batchDrop-' + batch.id + '">' +
          '<div class="small text-muted">+ Drop more files</div>' +
          '<input type="file" class="d-none" id="' + puid + '-batchFile-' + batch.id + '" multiple accept=".txt,.csv,.md,.json,.html,.xml,.pdf,.xlsx,.docx,.pptx,.png,.jpg,.jpeg"></div>' +
          '<div id="' + puid + '-batchStaged-' + batch.id + '"></div>' +
          '<div class="input-group input-group-sm">' +
          '<input type="text" class="form-control" id="' + puid + '-batchInput-' + batch.id + '" placeholder="Add files or type a message...">' +
          '<button class="btn btn-outline-primary" id="' + puid + '-batchSend-' + batch.id + '" type="button">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
          '</button></div></div>' +
          '<div class="batch-actions d-flex gap-2 mt-2">' +
          '<button class="btn btn-success btn-sm" id="' + puid + '-batchConfirm-' + batch.id + '"' + (batch.status !== 'ready' || batch.processing ? ' disabled' : '') + '>' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Confirm &amp; Merge</button>' +
          '<button class="btn btn-outline-danger btn-sm" id="' + puid + '-batchDiscard-' + batch.id + '">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Discard</button></div></div>';
      }

      var confirmedChatHtml = '';
      if (isConfirmed && batch.chatCount > 0) {
        confirmedChatHtml = '<div class="mt-2"><span class="badge bg-secondary ' + puid + '-chat-pill" data-batch="' + batch.id + '" role="button" tabindex="0">💬 ' + batch.chatCount + ' message(s)</span></div>';
      }

      var summaryHtml = '';
      if (isConfirmed && batch.summary) {
        summaryHtml = '<div class="batch-summary small text-muted mt-2">' + escapeHtml(batch.summary) + '</div>';
      }

      return '<div class="col"><div class="card h-100' + (isActive ? ' border-primary' : '') + '">' +
        '<div class="card-header d-flex align-items-center justify-content-between">' +
        '<span class="small fw-medium">' + batch.id + '</span>' + statusBadge + '</div>' +
        '<div class="card-body">' +
        '<div class="batch-files">' + filesHtml + '</div>' +
        summaryHtml + decisionsHtml + activeHtml + confirmedChatHtml +
        '</div></div></div>';
    }

    function wirePaneBatchCard(batch, puid) {
      // Decisions pill hover
      var pill = containerEl.querySelector('.' + puid + '-decisions-pill[data-batch="' + batch.id + '"]');
      if (pill) {
        var popover = document.getElementById(puid + '-decisions-' + batch.id);
        pill.addEventListener('mouseenter', function() { popover.classList.remove('d-none'); });
        pill.addEventListener('mouseleave', function() { popover.classList.add('d-none'); });
      }

      var isActive = batch.status === 'ready' || batch.status === 'open-items';
      var chatId = puid + '-batchChat-' + batch.id;

      // Confirmed: chat pill opens modal
      var chatPill = containerEl.querySelector('.' + puid + '-chat-pill[data-batch="' + batch.id + '"]');
      if (chatPill) {
        chatPill.addEventListener('click', async function() {
          chatPill.textContent = '💬 Loading...';
          try {
            var msgs = await fetch(api('/batch/' + batch.id + '/chat')).then(function(r) { return r.json(); });
            showChatModal(batch.id, msgs);
          } catch (e) { alert('Failed to load chat'); }
          chatPill.textContent = '💬 ' + batch.chatCount + ' message(s)';
        });
      }

      if (!isActive) return;

      // Populate existing chat
      if (batch.chat && batch.chat.length > 0) {
        for (var i = 0; i < batch.chat.length; i++) appendChat(chatId, batch.chat[i].role, batch.chat[i].text);
      }

      var confirmBtn = document.getElementById(puid + '-batchConfirm-' + batch.id);
      var sendBtn = document.getElementById(puid + '-batchSend-' + batch.id);
      var input = document.getElementById(puid + '-batchInput-' + batch.id);
      var drop = document.getElementById(puid + '-batchDrop-' + batch.id);
      var fileIn = document.getElementById(puid + '-batchFile-' + batch.id);
      var staged = document.getElementById(puid + '-batchStaged-' + batch.id);

      // Processing: spinner + SSE
      if (batch.processing) {
        showProcessingIndicator(chatId);
        if (confirmBtn) confirmBtn.disabled = true;
        connectSSE(batch.id, chatId, sendBtn, input, drop, confirmBtn, api, function() { refresh(); });
      }

      // File staging + send
      var updateSendState = function() {
        if (sendBtn) sendBtn.disabled = staging.getFiles().length === 0 && !input.value.trim();
      };
      var staging = createFileStagingUI(drop, fileIn, staged, input, updateSendState);
      if (sendBtn) sendBtn.disabled = true;

      if (sendBtn && input) {
        var doSend = function() { return unifiedSend(batch.id, staging, input, sendBtn, drop, chatId, confirmBtn, api); };
        sendBtn.addEventListener('click', doSend);
        input.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !sendBtn.disabled) doSend(); });
        input.addEventListener('input', updateSendState);
      }

      // Confirm
      if (confirmBtn) {
        confirmBtn.addEventListener('click', async function() {
          confirmBtn.disabled = true;
          try {
            var resp = await fetch(api('/batch/' + batch.id + '/confirm'), { method: 'POST' });
            if (!resp.ok) {
              var err = await resp.json();
              appendChat(chatId, 'system', err.error || 'Confirm failed');
              confirmBtn.disabled = false;
              return;
            }
            appendChat(chatId, 'system', 'Confirming and merging...');
            connectSSE(batch.id, chatId, sendBtn, input, drop, confirmBtn, api, function() { refresh(); });
          } catch (e) {
            appendChat(chatId, 'system', 'Confirm failed: ' + e.message);
            confirmBtn.disabled = false;
          }
        });
      }

      // Discard
      var discardBtn = document.getElementById(puid + '-batchDiscard-' + batch.id);
      if (discardBtn) {
        discardBtn.addEventListener('click', async function() {
          if (!confirm('Discard batch ' + batch.id + '? This will delete the branch and all changes.')) return;
          discardBtn.disabled = true;
          try {
            await fetch(api('/batch/' + batch.id + '/discard'), { method: 'POST' });
            refresh();
          } catch (e) { discardBtn.disabled = false; }
        });
      }
    }

    // Initial load
    refresh();

    return {
      destroy: function() {
        destroyed = true;
        if (pollId) { clearInterval(pollId); pollId = null; }
        containerEl.innerHTML = '';
      },
      refresh: refresh
    };
  }
};

// ---- Section-mode backward compat ----
// loadBatches() delegates to IngestUI.pane() targeting #ingestContainer.
// Uses the active repo ID from the platform for namespaced routing.
var _sectionPane = null;
function loadBatches() {
  var container = document.getElementById('ingestContainer');
  if (!container) return;
  var repoId = window.ACTIVE_REPO_ID;
  if (!repoId) { console.warn('loadBatches: no ACTIVE_REPO_ID set'); return; }
  if (_sectionPane) { _sectionPane.refresh(); return; }
  _sectionPane = IngestUI.pane(container, { apiBase: '/api/repo/' + repoId });
}

// ---- Shared: file staging logic ----
function createFileStagingUI(dropZoneEl, fileInputEl, stagedContainerEl, inputEl, onChange) {
  let stagedFiles = [];

  dropZoneEl.addEventListener('click', () => fileInputEl.click());
  dropZoneEl.addEventListener('dragover', e => { e.preventDefault(); dropZoneEl.classList.add('drag-over'); });
  dropZoneEl.addEventListener('dragleave', () => dropZoneEl.classList.remove('drag-over'));
  dropZoneEl.addEventListener('drop', e => {
    e.preventDefault();
    dropZoneEl.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });
  fileInputEl.addEventListener('change', e => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  function addFiles(fileList) {
    const rejected = [];
    for (const f of fileList) {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) { rejected.push(f.name); continue; }
      if (!stagedFiles.find(s => s.name === f.name)) stagedFiles.push(f);
    }
    if (rejected.length > 0) {
      alert('Unsupported file(s) skipped:\n' + rejected.join('\n') +
        '\n\nSupported: ' + [...ALLOWED_EXTENSIONS].join(', '));
    }
    renderStaged();
    if (onChange) onChange();
  }

  function renderStaged() {
    if (stagedFiles.length === 0) {
      stagedContainerEl.innerHTML = '';
      if (inputEl) inputEl.placeholder = 'Add files or type a message...';
      return;
    }
    if (inputEl) inputEl.placeholder = 'Add a note (optional) and hit Send to process...';
    stagedContainerEl.innerHTML = stagedFiles.map((f, i) => `
      <div class="staged-file d-flex align-items-center gap-2 mb-1">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="small flex-grow-1 text-truncate">${f.name}</span>
        <button class="btn btn-sm btn-link text-danger p-0 remove-staged-file" data-idx="${i}" title="Remove">&times;</button>
      </div>
    `).join('');
    stagedContainerEl.querySelectorAll('.remove-staged-file').forEach(btn => {
      btn.addEventListener('click', () => {
        stagedFiles.splice(parseInt(btn.dataset.idx), 1);
        renderStaged();
        if (onChange) onChange();
      });
    });
  }

  return {
    getFiles: () => stagedFiles,
    clear: () => { stagedFiles = []; renderStaged(); }
  };
}

// ---- Shared: unified send (files + optional message, or message only) ----
// apiFn(path) → full URL.  onDone() called after SSE completes.
async function unifiedSend(batchId, staging, inputEl, sendBtnEl, dropZoneEl, chatContainerId, confirmBtnEl, apiFn, onDone) {
  const message = inputEl.value.trim();
  const files = staging.getFiles();

  if (files.length === 0 && !message) return null;

  // Get or create batch ID
  let targetBatchId = batchId;
  if (!targetBatchId) {
    try {
      const resp = await fetch(apiFn('/batch/new'), { method: 'POST' });
      const result = await resp.json();
      targetBatchId = result.batchId;
    } catch (e) {
      appendChat(chatContainerId, 'system', 'Failed to create batch: ' + e.message);
      return null;
    }
  }

  // Build request body — always FormData
  const body = new FormData();
  for (const f of files) body.append('files', f, f.name);
  if (message) body.append('message', message);

  // Show in chat
  if (message) appendChat(chatContainerId, 'user', message);
  for (const f of files) appendChat(chatContainerId, 'system', '📎 ' + f.name);

  // Disable UI
  sendBtnEl.disabled = true;
  inputEl.disabled = true;
  inputEl.value = '';
  if (dropZoneEl) dropZoneEl.classList.add('disabled');
  if (confirmBtnEl) confirmBtnEl.disabled = true;
  staging.clear();
  showProcessingIndicator(chatContainerId);

  // Single API call
  try {
    const resp = await fetch(apiFn('/batch/' + targetBatchId + '/send'), { method: 'POST', body });
    const result = await resp.json();
    if (!resp.ok) {
      removeProcessingIndicator(chatContainerId);
      appendChat(chatContainerId, 'system', result.error || 'Request failed');
      sendBtnEl.disabled = false;
      inputEl.disabled = false;
      if (dropZoneEl) dropZoneEl.classList.remove('disabled');
      return null;
    }
    connectSSE(targetBatchId, chatContainerId, sendBtnEl, inputEl, dropZoneEl, confirmBtnEl, apiFn, onDone);
  } catch (e) {
    removeProcessingIndicator(chatContainerId);
    appendChat(chatContainerId, 'system', 'Failed: ' + e.message);
    sendBtnEl.disabled = false;
    inputEl.disabled = false;
    if (dropZoneEl) dropZoneEl.classList.remove('disabled');
    return null;
  }

  return targetBatchId;
}

// ---- Shared: SSE connection ----
// apiFn(path) → full URL.  onDone() called when SSE signals completion.
function connectSSE(batchId, chatContainerId, sendBtnEl, inputEl, dropZoneEl, confirmBtnEl, apiFn, onDone) {
  const sse = new EventSource(apiFn('/batch/' + batchId + '/stream'));

  sse.addEventListener('processing', e => {
    showProcessingIndicator(chatContainerId);
    if (confirmBtnEl) confirmBtnEl.disabled = true;
  });

  sse.addEventListener('message', e => {
    const data = JSON.parse(e.data);
    if (data.role) {
      if (data.role === 'system' && /^(Processing|Running|Ingesting|Starting|Loading)/i.test(data.text.trim())) {
        updateProcessingIndicator(chatContainerId, data.text);
        return;
      }
      removeProcessingIndicator(chatContainerId);
      appendChat(chatContainerId, data.role, data.text);
    }
  });

  sse.addEventListener('done', e => {
    const data = JSON.parse(e.data);
    removeProcessingIndicator(chatContainerId);
    appendChat(chatContainerId, 'system', data.summary || 'Done.');
    if (sendBtnEl) sendBtnEl.disabled = false;
    if (inputEl) { inputEl.disabled = false; inputEl.placeholder = 'Add files or type a message...'; }
    if (dropZoneEl) dropZoneEl.classList.remove('disabled');
    if (confirmBtnEl) confirmBtnEl.disabled = false;
    if (onDone) onDone();
    sse.close();
  });

  sse.onerror = () => {
    sse.close();
    if (sendBtnEl) sendBtnEl.disabled = false;
    if (inputEl) inputEl.disabled = false;
    if (dropZoneEl) dropZoneEl.classList.remove('disabled');
    removeProcessingIndicator(chatContainerId);
  };
}

// ---- Shared: chat helpers ----
function appendChat(containerId, role, text) {
  const container = document.getElementById(containerId);
  if (!container) return;
  removeProcessingIndicator(containerId);
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-${role}`;
  const icon = role === 'user' ? '👤' : role === 'assistant' ? '🤖' : 'ℹ️';
  const rendered = role === 'assistant' && typeof marked !== 'undefined'
    ? marked.parse(text)
    : escapeHtml(text);
  bubble.innerHTML = `<span class="chat-icon">${icon}</span><span class="chat-text">${rendered}</span>`;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function showProcessingIndicator(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  removeProcessingIndicator(containerId);
  const indicator = document.createElement('div');
  indicator.className = 'chat-bubble chat-system chat-processing';
  indicator.innerHTML = `<span class="chat-icon"><span class="spinner-border spinner-border-sm" role="status"></span></span><span class="chat-text">Processing...</span>`;
  container.appendChild(indicator);
  container.scrollTop = container.scrollHeight;
}

function removeProcessingIndicator(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const indicator = container.querySelector('.chat-processing');
  if (indicator) indicator.remove();
}

function updateProcessingIndicator(containerId, text) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let indicator = container.querySelector('.chat-processing');
  if (!indicator) {
    showProcessingIndicator(containerId);
    indicator = container.querySelector('.chat-processing');
  }
  if (indicator) {
    const span = indicator.querySelector('.chat-text');
    if (span) span.textContent = text;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showChatModal(batchId, messages) {
  // Remove any existing modal
  let modal = document.getElementById('chatModal');
  if (modal) modal.remove();
  let backdrop = document.querySelector('.modal-backdrop');
  if (backdrop) backdrop.remove();

  const modalEl = document.createElement('div');
  modalEl.innerHTML = `
    <div class="modal fade" id="chatModal" tabindex="-1">
      <div class="modal-dialog modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h6 class="modal-title">${escapeHtml(batchId)}</h6>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="chat-messages" id="modalChat-${batchId}"></div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modalEl.firstElementChild);

  // Reuse appendChat for consistent markdown rendering
  for (const msg of messages) appendChat(`modalChat-${batchId}`, msg.role, msg.text);

  const bsModal = new bootstrap.Modal(document.getElementById('chatModal'));
  bsModal.show();

  // Clean up on close
  document.getElementById('chatModal').addEventListener('hidden.bs.modal', () => {
    document.getElementById('chatModal').remove();
  });
}
