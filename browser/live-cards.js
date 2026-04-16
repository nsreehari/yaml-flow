// live-cards.js — LiveCards v3: Node-based Board/Canvas engine
//
// Schema: Each node has { id, type, meta, data, view?, source?, state, compute? }
//   type "card"   — renderable node with view.elements[]
//   type "source" — data-only node (no view, shown as pill in canvas)
//
// Uses Bootstrap 5 for layout/forms, optional Chart.js for charts.
// Uses CardCompute (card-compute.js) for declarative compute expressions.
//
// API:
//   const engine = LiveCard.init({ resolve, onPatch, onPatchState, onRefresh, onChat, markdown, sanitize, chartLib });
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
      @media (max-width:576px) {
        .lc-metric-value { font-size:1.5rem; }
        .lc-chart-wrap { min-height:150px; }
        .lc-chat-msg { max-width:95%; }
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

  function _deepGet(obj, path) {
    if (!path || !obj) return undefined;
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function _deepSet(obj, path, value) {
    const parts = path.split('.');
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
    };

    const _cleanup = {};   // nodeId → { ac, timers, charts, unsubs }
    const _subs = {};      // nodeId → Set<callback>
    const _renderers = {}; // kind → fn
    const _nodeEls = {};   // nodeId → { container, resultEl, uid }

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

    function _runCompute(node) {
      if (!node.compute) return;
      if (typeof CardCompute !== 'undefined') {
        try { CardCompute.run(node); }
        catch (e) { console.error('LiveCard compute error', node.id, e); }
      }
    }

    function _resolveBind(node, bind) {
      if (!bind) return undefined;
      return _deepGet(node, bind);
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
      const requires = (node.data && node.data.requires) || [];
      if (!requires.length) return;
      const cleanup = _getCleanup(node.id);
      cleanup.unsubs = requires.map(upId => subscribe(upId, () => {
        const info = _nodeEls[node.id];
        if (!info || !info.resultEl) return;
        const updated = cfg.resolve(node.id);
        if (!updated) return;
        _runCompute(updated);
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
      const values = writeTo ? (_resolveBind(node, writeTo) || {}) : (data && typeof data === 'object' ? data : {});

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
        if (values[key] != null) {
          if (prop.type === 'boolean') input.checked = !!values[key];
          else if (prop.format === 'date') input.value = String(values[key]).slice(0, 10);
          else input.value = values[key];
        }
        form.appendChild(col);
      });

      const btnCol = document.createElement('div');
      btnCol.className = 'col-12 mt-1';
      const btn = document.createElement('button');
      btn.type = 'submit'; btn.className = 'btn btn-sm btn-primary'; btn.textContent = 'Submit';
      btnCol.appendChild(btn);
      form.appendChild(btnCol);

      el.innerHTML = '';
      el.appendChild(form);

      form.addEventListener('submit', e => {
        e.preventDefault();
        if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
        const vals = {};
        form.querySelectorAll('[data-key]').forEach(inp => {
          const k = inp.dataset.key, p = props[k];
          if (p.type === 'boolean') vals[k] = inp.checked;
          else if (p.type === 'number' || p.type === 'integer') vals[k] = inp.value ? parseFloat(inp.value) : 0;
          else vals[k] = inp.value;
        });
        if (writeTo) _deepSet(node, writeTo, vals);
        cfg.onPatchState(node.id, { fieldValues: vals });
        notify(node.id, vals);
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
      const content = typeof data === 'string' ? data : '';

      el.innerHTML = `
        <div class="btn-group btn-group-sm mb-2" role="group">
          <button class="btn btn-outline-secondary active lc-n-edit" type="button">Edit</button>
          <button class="btn btn-outline-secondary lc-n-preview" type="button">Preview</button>
        </div>
        <textarea class="form-control form-control-sm lc-notes-textarea" rows="8" placeholder="Write markdown...">${_esc(content)}</textarea>
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
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (writeTo) _deepSet(node, writeTo, textarea.value);
          cfg.onPatchState(node.id, { notes: textarea.value });
        }, 800);
        cleanup.timers.push(timer);
      }, { signal });
    }

    // ---- todo ----

    function _renderTodo(data, el, elemDef, node) {
      const cleanup = _getCleanup(node.id);
      const signal = cleanup.ac.signal;
      const ed = elemDef.data || {};
      const writeTo = ed.writeTo;
      const items = Array.isArray(data) ? data : [];

      function save() {
        if (writeTo) _deepSet(node, writeTo, items);
        cfg.onPatchState(node.id, { items });
      }

      function build() {
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
          cb.addEventListener('change', () => { items[parseInt(cb.dataset.idx)].done = cb.checked; save(); build(); }, { signal });
        });
        el.querySelectorAll('[data-rm]').forEach(btn => {
          btn.addEventListener('click', () => { items.splice(parseInt(btn.dataset.rm), 1); save(); build(); }, { signal });
        });
        const addInput = el.querySelector('.input-group input');
        const addBtn = el.querySelector('.lc-todo-add');
        const addItem = () => { const t = addInput.value.trim(); if (!t) return; items.push({ text: t, done: false }); save(); build(); };
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
      const style = ed.style || 'default';
      const tag = style === 'heading' ? 'h4' : 'div';
      const cls = style === 'muted' ? 'text-muted small' : (style === 'heading' ? 'fw-bold' : 'small');
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

    // ---- Register built-in renderers ----

    _renderers.table     = _renderTable;
    _renderers.filter    = _renderFilter;
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

    // ===========================================================================
    // _renderElements — render all view.elements for a card node
    // ===========================================================================

    function _renderElements(node, containerEl) {
      const view = node.view;
      if (!view || !Array.isArray(view.elements)) { containerEl.innerHTML = ''; return; }

      const container = document.createElement('div');
      container.className = 'row g-2';

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
      const features = (node.view && node.view.features) || {};

      // Run compute before render
      _runCompute(node);

      let h = `<div class="lc-card" id="${uid}">`;

      // Header bar: status dot + time-ago + refresh button
      const showRefresh = features.refresh !== false && cfg.onRefresh;
      h += `<div class="d-flex align-items-center gap-2 mb-2">`;
      h += _statusDot(node.state && node.state.status);
      h += `<span class="text-muted small">${_timeAgo(node.state && node.state.lastRun)}</span>`;
      if (node.state && node.state.status === 'error' && node.state.error) {
        h += `<span class="badge bg-danger small" title="${_esc(node.state.error)}">Error</span>`;
      }
      if (showRefresh) {
        h += `<button class="btn btn-sm btn-outline-secondary ms-auto" id="${uid}-refresh" title="Refresh">`;
        h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
        h += '</button>';
      }
      h += '</div>';

      // Elements area
      h += `<div class="lc-result" id="${uid}-result"></div>`;

      // Notes section (feature toggle)
      if (features.notes && opts.showNotes !== false) {
        h += `<details class="mt-2"><summary class="small fw-medium">Notes</summary>`;
        h += `<textarea class="form-control form-control-sm mt-1" id="${uid}-notes" rows="3" placeholder="Add notes...">${_esc((node.state && node.state._notes) || '')}</textarea></details>`;
      }

      // Chat section (feature toggle)
      if (features.chat && cfg.onChat && opts.showChat !== false) {
        h += `<details class="mt-2"><summary class="small fw-medium">Chat</summary>`;
        h += `<div class="lc-chat-messages" id="${uid}-chat"></div>`;
        h += `<div class="input-group input-group-sm mt-1">`;
        h += `<input type="text" class="form-control" id="${uid}-chatInput" placeholder="Ask about this card...">`;
        h += `<button class="btn btn-outline-primary" id="${uid}-chatSend">`;
        h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
        h += '</button></div></details>';
      }

      h += '</div>';
      containerEl.innerHTML = h;

      // ---- Render elements ----
      const resultEl = document.getElementById(uid + '-result');
      _nodeEls[node.id] = { container: containerEl, resultEl, uid };

      if (node.state && node.state.status === 'loading') {
        resultEl.innerHTML = '<div class="d-flex align-items-center gap-2"><span class="spinner-border spinner-border-sm text-muted"></span><span class="text-muted small">Loading…</span></div>';
      } else if (node.state && node.state.status === 'error' && node.state.error) {
        resultEl.innerHTML = `<div class="text-danger small fw-semibold">Refresh failed</div><pre class="text-muted small mt-1" style="white-space:pre-wrap">${_esc(node.state.error)}</pre>`;
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

      // ---- Wire notes ----
      const notesEl = document.getElementById(uid + '-notes');
      if (notesEl) {
        let nTimer;
        notesEl.addEventListener('input', () => {
          clearTimeout(nTimer);
          nTimer = setTimeout(() => {
            if (!node.state) node.state = {};
            node.state._notes = notesEl.value;
            cfg.onPatch(node.id, { _notes: notesEl.value });
          }, 800);
          cleanup.timers.push(nTimer);
        }, { signal });
      }

      // ---- Wire chat ----
      const chatInput = document.getElementById(uid + '-chatInput');
      const chatSend = document.getElementById(uid + '-chatSend');
      if (chatInput && chatSend && cfg.onChat) {
        const send = () => {
          const msg = chatInput.value.trim();
          if (!msg) return;
          chatInput.value = '';
          appendChatMessage(node.id, 'user', msg);
          cfg.onChat(node.id, msg);
        };
        chatSend.addEventListener('click', send, { signal });
        chatInput.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
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

      // Merge into node state
      const node = cfg.resolve(nodeId);
      if (!node) return;
      if (!node.state) node.state = {};
      if (patch.status) node.state.status = patch.status;
      if (patch.lastRun) node.state.lastRun = patch.lastRun;
      if (patch.error !== undefined) node.state.error = patch.error;

      if (node.state.status === 'loading') {
        info.resultEl.innerHTML = '<div class="d-flex align-items-center gap-2"><span class="spinner-border spinner-border-sm text-muted"></span><span class="text-muted small">Loading…</span></div>';
      } else if (node.state.status === 'error' && node.state.error) {
        info.resultEl.innerHTML = `<div class="text-danger small fw-semibold">Refresh failed</div><pre class="text-muted small mt-1" style="white-space:pre-wrap">${_esc(node.state.error)}</pre>`;
      } else {
        _runCompute(node);
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
    }

    // ===========================================================================
    // Chat
    // ===========================================================================

    function appendChatMessage(nodeId, role, text) {
      const info = _nodeEls[nodeId];
      if (!info) return;
      const chatEl = info.container.querySelector('.lc-chat-messages');
      if (!chatEl) return;
      const msg = document.createElement('div');
      msg.className = `lc-chat-msg small ${role === 'user' ? 'lc-chat-user' : 'lc-chat-assistant'}`;
      msg.innerHTML = role === 'assistant' ? _renderMd(text) : _esc(text);
      chatEl.appendChild(msg);
      chatEl.scrollTop = chatEl.scrollHeight;
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
    const nodeList = [];
    const nodeMap = {};        // id → { node, colEl, bodyEl }
    const _positions = {};     // id → { x, y, w, h } for canvas mode
    const showNotes = opts.showNotes !== false;
    const showChat  = opts.showChat || false;
    const defaultCol = opts.defaultCol || 6;

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

    // ---- Helpers ----

    function _colWidth(node) {
      if (node.view && node.view.layout && node.view.layout.board && node.view.layout.board.col) return node.view.layout.board.col;
      return defaultCol;
    }

    function _initPositions() {
      const explicit = opts.positions || {};
      nodeList.forEach((node, i) => {
        if (_positions[node.id]) return; // already set
        if (explicit[node.id]) {
          _positions[node.id] = Object.assign({}, explicit[node.id]);
        } else if (node.view && node.view.layout && node.view.layout.canvas && node.view.layout.canvas.x != null) {
          _positions[node.id] = Object.assign({}, node.view.layout.canvas);
        } else {
          const col = (i % 4);
          const row = Math.floor(i / 4);
          _positions[node.id] = { x: col * cvs.gapX + cvs.padX, y: row * cvs.gapY + cvs.padY, w: cvs.defaultW };
        }
      });
    }

    function _getRequires(node) {
      return (node.data && node.data.requires) || [];
    }

    function _buildCardWrapper(node) {
      const wrap = document.createElement('div');
      wrap.className = 'card shadow-sm h-100';
      const header = document.createElement('div');
      header.className = 'card-header d-flex align-items-center gap-2 py-2';
      const title = (node.meta && node.meta.title) || node.id;
      const tags = (node.meta && node.meta.tags) || [];
      let badgeHtml = '';
      if (node.type === 'source' && node.source) {
        badgeHtml = '<span class="badge bg-info text-dark ms-auto">' + _esc(node.source.kind || 'source') + '</span>';
      } else if (tags.length) {
        badgeHtml = tags.map(t => '<span class="badge bg-secondary ms-1">' + _esc(t) + '</span>').join('');
      }
      header.innerHTML = '<strong class="small">' + _esc(title) + '</strong>' + badgeHtml;
      const body = document.createElement('div');
      body.className = 'card-body p-2';
      wrap.appendChild(header);
      wrap.appendChild(body);
      return { wrap, header, body };
    }

    function _buildSourcePill(node) {
      const el = document.createElement('div');
      el.className = 'lc-source-node';
      const status = (node.state && node.state.status) || 'fresh';
      const title = (node.meta && node.meta.title) || node.id;
      const kind = (node.source && node.source.kind) || 'source';
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
      const cards = nodeList.filter(n => n.type === 'card').slice();
      cards.sort((a, b) => {
        const ao = (a.view && a.view.layout && a.view.layout.board && a.view.layout.board.order) || 0;
        const bo = (b.view && b.view.layout && b.view.layout.board && b.view.layout.board.order) || 0;
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
        if (node.type === 'card' && node.view) {
          if (!node.view.layout) node.view.layout = {};
          if (!node.view.layout.canvas) node.view.layout.canvas = {};
          node.view.layout.canvas.x = x;
          node.view.layout.canvas.y = y;
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

        if (node.type === 'source') {
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
        if (n.type === 'card' && n.view) {
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

    function destroy() {
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
      autoLayout,
      destroy,
      get mode() { return mode.current; },
      get nodes() { return nodeList.slice(); },
      get engine() { return engine; },
    };
  }

  // ===========================================================================
  // Module export
  // ===========================================================================

  return { init, Board };
})();
