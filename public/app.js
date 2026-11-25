(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const state = {
    view: 'overview',
    me: null,
    settings: null,
    keys: [],
    logPage: 0,
    logLimit: 25,
    lastCurl: '',
    order: ['tmpfiles', 'uguu', 'litterbox', 'catbox'],
  };

  async function api(path, options = {}) {
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      });
      let data = null;
      try { data = await response.json(); } catch { /* non-json */ }
      return { ok: response.ok, status: response.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { error: err.message } };
    }
  }

  const post = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body || {}) });

  function toast(message, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    $('#toast-root').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function showModal(title, bodyHtml, footHtml = '') {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-foot').innerHTML = footHtml;
    $('#modal-root').hidden = false;
  }

  function closeModal() { $('#modal-root').hidden = true; }

  function confirmModal(title, message, onConfirm, okLabel = 'Confirm') {
    showModal(title, `<p>${esc(message)}</p>`,
      `<button class="btn btn-ghost" data-modal-cancel>Cancel</button><button class="btn btn-danger" data-modal-confirm>${esc(okLabel)}</button>`);
    $('[data-modal-confirm]').onclick = async () => {
      closeModal();
      await onConfirm();
    };
    $('[data-modal-cancel]').onclick = closeModal;
  }

  async function copyText(text, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      toast(label, 'success');
    } catch {
      toast('Clipboard unavailable — select and copy manually', 'error');
    }
  }

  const fmtDate = (ts) => ts ? new Date(ts).toLocaleString() : '—';
  const fmtNum = (n) => Number(n || 0).toLocaleString();

  // ---------- auth ----------
  async function checkSession() {
    const result = await api('/api/admin/me');
    if (!result.ok) {
      $('#login-view').hidden = false;
      $('#app-view').hidden = true;
      return false;
    }
    state.me = result.data;
    $('#version-label').textContent = 'v' + (result.data.version || '?');
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    return true;
  }

  function setupAuth() {
    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = $('#login-error');
      error.hidden = true;
      const key = $('#admin-key').value;
      const button = $('#login-form button[type="submit"]');
      button.disabled = true;
      const result = await post('/api/admin/login', { key });
      button.disabled = false;
      if (!result.ok) {
        error.textContent = result.data?.error || 'Sign in failed';
        error.hidden = false;
        return;
      }
      $('#admin-key').value = '';
      await checkSession();
      await loadView();
    });

    $('#logout-btn').addEventListener('click', async () => {
      await post('/api/admin/logout', {});
      state.me = null;
      $('#app-view').hidden = true;
      $('#login-view').hidden = false;
      $('#admin-key').value = '';
    });
  }

  // ---------- navigation ----------
  const TITLES = {
    overview: ['Overview', 'Live status and usage at a glance'],
    keys: ['API Keys', 'Create and manage keys for cURL and integrations'],
    playground: ['Playground', 'Send a test request and inspect the result'],
    logs: ['Logs', 'Request history — retained for 10 days maximum'],
    settings: ['Settings', 'Control behaviour, uploads, and protection'],
    docs: ['API Docs', 'Endpoints and request parameters'],
  };

  function setupNav() {
    $$('.nav-item').forEach(button => {
      button.addEventListener('click', () => {
        state.view = button.dataset.view;
        $$('.nav-item').forEach(b => b.classList.toggle('active', b === button));
        const titles = TITLES[state.view] || ['', ''];
        $('#view-title').textContent = titles[0];
        $('#view-subtitle').textContent = titles[1];
        $$('.view').forEach(section => { section.hidden = section.id !== 'view-' + state.view; });
        loadView();
      });
    });

    $('#refresh-btn').addEventListener('click', () => loadView(true));
  }

  async function loadView(force = false) {
    if (!state.me) return;
    $('#status-dot').classList.remove('online');
    $('#status-text').textContent = 'Loading…';
    try {
      if (state.view === 'overview') await loadOverview();
      else if (state.view === 'keys') await loadKeys();
      else if (state.view === 'logs') await loadLogs();
      else if (state.view === 'settings') await loadSettings(force);
      else if (state.view === 'docs') await loadDocs();
      $('#status-dot').classList.add('online');
      $('#status-text').textContent = 'Connected';
    } catch (err) {
      $('#status-text').textContent = 'Error';
      toast(err.message || 'Could not load data', 'error');
    }
  }

  // ---------- overview ----------
  async function loadOverview() {
    const [overview, keys] = await Promise.all([api('/api/admin/overview'), api('/api/admin/keys')]);
    if (!overview.ok || !keys.ok) throw new Error('Failed to load overview');
    state.keys = keys.data.items || [];

    const o = overview.data;
    $('#stats-grid').innerHTML = `
      <div class="stat"><div class="label">Requests (24h)</div><div class="value">${fmtNum(o.requests24h)}</div><div class="sub">${fmtNum(o.requests)} all time</div></div>
      <div class="stat ok"><div class="label">Success rate</div><div class="value">${o.successRate24h}%</div><div class="sub">${fmtNum(o.errors24h)} errors in 24h</div></div>
      <div class="stat accent"><div class="label">Avg. latency</div><div class="value">${fmtNum(o.avgDurationMs)}</div><div class="sub">milliseconds per request</div></div>
      <div class="stat"><div class="label">Active keys</div><div class="value">${fmtNum(o.activeKeys)}</div><div class="sub">of ${fmtNum(o.totalKeys)} total</div></div>`;

    const maxCount = Math.max(1, ...o.hours.map(x => x.count));
    $('#hourly-chart').innerHTML = `<div class="hourly">${o.hours.map(x => `
      <div class="hcol"><meter min="0" max="${maxCount}" value="${x.count}" title="${x.label} — ${x.count} requests, ${x.errors} errors"></meter><span>${esc(x.label.slice(0, 2))}</span></div>`).join('')}</div>`;

    const recent = await api('/api/admin/logs?limit=6');
    $('#recent-activity').innerHTML = recent.ok && recent.data.items.length
      ? `<table class="table"><thead><tr><th>Time</th><th>Status</th><th>Path</th><th>Time taken</th></tr></thead><tbody>${recent.data.items.map(log => `
          <tr><td class="mono">${esc(new Date(log.ts).toLocaleTimeString())}</td>
          <td><span class="tag ${log.status < 400 ? 'ok' : 'err'}">${esc(log.status)}</span></td>
          <td class="mono">${esc(log.path)}</td><td>${fmtNum(log.durationMs)} ms</td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">No requests logged yet.</p>';

    const usable = state.keys.filter(k => k.enabled);
    const key = usable.length ? usable[0].prefix + '…' : '<YOUR_API_KEY>';
    const curl = `curl -X POST ${location.origin}/embed-metadata \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '{"image_path":"https://example.com/photo.jpg","title":"My photo","keywords":["nature"]}'`;
    $('#quickstart').innerHTML = `
      <p class="muted">Generate an API key under <strong>API Keys</strong>, then call either endpoint with the Bearer header.</p>
      <div class="code-head"><span>Example</span><button class="btn btn-ghost btn-sm" data-copy-quick>Copy</button></div>
      <pre class="code-block">${esc(curl)}</pre>`;
    $('[data-copy-quick]').onclick = () => copyText(curl);
  }

  // ---------- keys ----------
  async function loadKeys() {
    const result = await api('/api/admin/keys');
    if (!result.ok) throw new Error('Failed to load keys');
    state.keys = result.data.items || [];
    const table = $('#keys-table');
    if (!state.keys.length) {
      table.innerHTML = '<tbody><tr><td class="empty">No keys yet. Create one to start using the API.</td></tr></tbody>';
      return;
    }
    table.innerHTML = `
      <thead><tr><th>Name</th><th>Key</th><th>Requests</th><th>Last used</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${state.keys.map(k => `
        <tr>
          <td>${esc(k.name)}</td>
          <td class="mono">${esc(k.prefix)}…</td>
          <td>${fmtNum(k.requests)}</td>
          <td class="mono">${esc(fmtDate(k.lastUsedAt))}</td>
          <td class="mono">${esc(k.expiresAt ? fmtDate(k.expiresAt) : 'Never')}</td>
          <td><span class="tag ${k.enabled ? 'ok' : 'off'}">${k.enabled ? 'Active' : 'Disabled'}</span></td>
          <td><div class="actions">
            <button class="btn btn-ghost btn-sm" data-toggle="${esc(k.id)}" data-enabled="${k.enabled}">${k.enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-danger btn-sm" data-delete="${esc(k.id)}" data-name="${esc(k.name)}">Delete</button>
          </div></td>
        </tr>`).join('')}</tbody>`;

    $$('[data-toggle]', table).forEach(button => {
      button.onclick = async () => {
        const result = await post('/api/admin/keys/' + button.dataset.toggle, { enabled: button.dataset.enabled !== 'true' }, 'PATCH');
        if (!result.ok) return toast(result.data?.error || 'Failed to update key', 'error');
        toast('Key updated', 'success');
        await loadKeys();
      };
    });
    $$('[data-delete]', table).forEach(button => {
      button.onclick = () => confirmModal('Delete API key', `Delete "${button.dataset.name}"? Requests using it will stop working immediately.`, async () => {
        const result = await api('/api/admin/keys/' + button.dataset.delete, { method: 'DELETE' });
        if (!result.ok) return toast(result.data?.error || 'Failed to delete', 'error');
        toast('Key deleted', 'success');
        await loadKeys();
      }, 'Delete');
    });
  }

  function setupKeys() {
    $('#create-key-btn').addEventListener('click', () => {
      showModal('Create API key', `
        <div class="setting"><label for="k-name">Name</label><input id="k-name" placeholder="e.g. Production server"></div>
        <div class="setting"><label for="k-days">Expires after (days)</label><input id="k-days" type="number" min="1" max="3650" placeholder="Never"></div>
        <div class="setting"><label for="k-rl">Rate limit (requests / window)</label><input id="k-rl" type="number" min="1" max="1000000" placeholder="Use global default"></div>`,
        `<button class="btn btn-ghost" data-modal-cancel>Cancel</button><button class="btn btn-primary" data-modal-confirm>Create</button>`);
      $('[data-modal-cancel]').onclick = closeModal;
      $('[data-modal-confirm]').onclick = async () => {
        const payload = { name: $('#k-name').value || 'Untitled key' };
        if ($('#k-days').value) payload.expiresInDays = Number($('#k-days').value);
        if ($('#k-rl').value) payload.rateLimitMax = Number($('#k-rl').value);
        const result = await post('/api/admin/keys', payload);
        if (!result.ok) return toast(result.data?.error || 'Failed to create key', 'error');
        closeModal();
        showSecret(result.data.secret);
        await loadKeys();
      };
    });
  }

  function showSecret(secret) {
    showModal('Save this API key', `
      <p>Copy it now — it will not be shown again.</p>
      <div class="secret-box mono" id="new-secret">${esc(secret)}</div>`,
      `<button class="btn btn-primary" data-copy-secret>Copy &amp; close</button>`);
    $('[data-copy-secret]').onclick = async () => {
      await copyText(secret, 'API key copied');
      closeModal();
    };
  }

  // ---------- logs ----------
  async function loadLogs() {
    $('#log-retention-note').textContent = '(auto-deleted after ' + (state.settings?.logRetentionDays || 10) + ' days)';
    const params = new URLSearchParams({
      limit: String(state.logLimit),
      offset: String(state.logPage * state.logLimit),
      status: $('#log-status').value,
      q: $('#log-search').value,
    });
    const result = await api('/api/admin/logs?' + params.toString());
    if (!result.ok) throw new Error('Failed to load logs');
    const table = $('#logs-table');
    if (!result.data.items.length) {
      table.innerHTML = '<tbody><tr><td class="empty">No matching logs.</td></tr></tbody>';
    } else {
      table.innerHTML = `
        <thead><tr><th>Time</th><th>Status</th><th>Method</th><th>Path</th><th>Duration</th><th>Provider</th><th>Message</th></tr></thead>
        <tbody>${result.data.items.map(log => `
          <tr>
            <td class="mono">${esc(fmtDate(log.ts))}</td>
            <td><span class="tag ${log.status < 400 ? 'ok' : 'err'}">${esc(log.status)}</span></td>
            <td class="mono">${esc(log.method)}</td>
            <td class="mono">${esc(log.path)}</td>
            <td>${fmtNum(log.durationMs)} ms</td>
            <td>${esc(log.provider || '—')}</td>
            <td>${esc(log.message || '—')}</td>
          </tr>`).join('')}</tbody>`;
    }
    $('#log-page').textContent = `Page ${state.logPage + 1} · ${fmtNum(result.data.total)} entries`;
    $('#log-prev').disabled = state.logPage === 0;
    $('#log-next').disabled = (state.logPage + 1) * state.logLimit >= result.data.total;
  }

  function setupLogs() {
    $('#log-filter-btn').onclick = () => { state.logPage = 0; loadLogs(); };
    $('#log-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.logPage = 0; loadLogs(); } });
    $('#log-prev').onclick = () => { if (state.logPage > 0) { state.logPage--; loadLogs(); } };
    $('#log-next').onclick = () => { state.logPage++; loadLogs(); };
    $('#clear-logs-btn').onclick = () => confirmModal('Clear logs', 'Delete all stored request logs? This cannot be undone.', async () => {
      const result = await api('/api/admin/logs', { method: 'DELETE' });
      if (!result.ok) return toast(result.data?.error || 'Failed to clear logs', 'error');
      toast('Logs cleared', 'success');
      state.logPage = 0;
      await loadLogs();
    }, 'Clear');
  }

  // ---------- settings ----------
  async function loadSettings(force = false) {
    if (!state.settings || force) {
      const result = await api('/api/admin/settings');
      if (!result.ok) throw new Error('Failed to load settings');
      state.settings = result.data;
    }
    const s = state.settings;
    $('#s-anon').checked = !!s.allowAnonymous;
    $('#s-uploadmode').value = s.uploadMode || 'external';
    $('#s-longlived').checked = s.createLongLivedLink !== false;
    $('#s-localttl').value = s.localFileTtlHours ?? 24;
    $('#s-baseurl').value = s.publicBaseUrl || '';
    $('#s-profile').value = s.defaultCameraProfile || '';
    $('#s-rlenabled').checked = !!s.rateLimitEnabled;
    $('#s-rlmax').value = s.rateLimitMax || 60;
    $('#s-rlwindow').value = s.rateLimitWindowMs || 60000;
    $('#s-retention').value = s.logRetentionDays || 10;
    const loc = s.defaultLocation || {};
    $('#s-city').value = loc.city || '';
    $('#s-country').value = loc.country || '';
    $('#s-lat').value = loc.lat ?? '';
    $('#s-lon').value = loc.lon ?? '';
    state.order = Array.isArray(s.uploadOrder) ? [...s.uploadOrder] : ['tmpfiles', 'uguu', 'litterbox', 'catbox'];
    renderOrder();
    toggleUploadFields();
  }

  function renderOrder() {
    $('#s-order').innerHTML = state.order.map((name, index) => `
      <div class="order-row"><code>${esc(name)}</code>
        <button class="btn btn-ghost btn-sm" data-up="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-ghost btn-sm" data-down="${index}" ${index === state.order.length - 1 ? 'disabled' : ''}>↓</button>
      </div>`).join('');
    $$('[data-up]', $('#s-order')).forEach(b => b.onclick = () => {
      const i = Number(b.dataset.up);
      [state.order[i - 1], state.order[i]] = [state.order[i], state.order[i - 1]];
      renderOrder();
    });
    $$('[data-down]', $('#s-order')).forEach(b => b.onclick = () => {
      const i = Number(b.dataset.down);
      [state.order[i + 1], state.order[i]] = [state.order[i], state.order[i + 1]];
      renderOrder();
    });
  }

  function toggleUploadFields() {
    const local = $('#s-uploadmode').value === 'local';
    $('#s-order-wrap').hidden = local;
    $('#s-longlived-wrap').hidden = local;
    $('#s-localttl-wrap').hidden = !local;
  }

  function setupSettings() {
    $('#s-uploadmode').addEventListener('change', toggleUploadFields);

    $('#save-settings-btn').onclick = async () => {
      const lat = $('#s-lat').value, lon = $('#s-lon').value;
      const hasLocation = $('#s-city').value || $('#s-country').value || lat !== '' || lon !== '';
      const payload = {
        allowAnonymous: $('#s-anon').checked,
        uploadMode: $('#s-uploadmode').value,
        uploadOrder: state.order,
        createLongLivedLink: $('#s-longlived').checked,
        publicBaseUrl: $('#s-baseurl').value.trim(),
        defaultCameraProfile: $('#s-profile').value,
        defaultLocation: hasLocation ? {
          lat: Number(lat || 0), lon: Number(lon || 0),
          city: $('#s-city').value.trim() || 'Unknown',
          country: $('#s-country').value.trim() || 'Unknown',
        } : null,
        rateLimitEnabled: $('#s-rlenabled').checked,
        rateLimitMax: Number($('#s-rlmax').value),
        rateLimitWindowMs: Number($('#s-rlwindow').value),
        localFileTtlHours: Number($('#s-localttl').value),
      };
      const button = $('#save-settings-btn');
      button.disabled = true;
      const result = await post('/api/admin/settings', payload, 'PATCH');
      button.disabled = false;
      if (!result.ok) return toast(result.data?.error || 'Failed to save settings', 'error');
      state.settings = result.data.settings;
      toast('Settings saved', 'success');
    };

    $('#rotate-key-btn').onclick = () => {
      showModal('Rotate admin key', `
        <p>Leave blank to generate a strong random key. You will be signed out afterwards.</p>
        <div class="setting"><label for="r-new">New admin key</label><input id="r-new" type="password" placeholder="Random if blank"></div>`,
        `<button class="btn btn-ghost" data-modal-cancel>Cancel</button><button class="btn btn-danger" data-modal-confirm>Rotate</button>`);
      $('[data-modal-cancel]').onclick = closeModal;
      $('[data-modal-confirm]').onclick = async () => {
        const result = await post('/api/admin/settings/admin-key', { newKey: $('#r-new').value });
        if (!result.ok) return toast(result.data?.error || 'Failed to rotate key', 'error');
        closeModal();
        showModal('New admin key', `<p>Save this key — the old one no longer works and all sessions were cleared.</p><div class="secret-box mono">${esc(result.data.key)}</div>`,
          `<button class="btn btn-primary" data-copy-new>Copy &amp; sign out</button>`);
        $('[data-copy-new]').onclick = async () => {
          await copyText(result.data.key, 'Admin key copied');
          closeModal();
          $('#app-view').hidden = true;
          $('#login-view').hidden = false;
          state.me = null;
        };
      };
    };
  }

  // ---------- playground ----------
  function buildTestPayload() {
    const mode = $('#t-mode').value;
    const payload = { image_path: $('#t-image').value.trim() };
    if (mode === 'embed-metadata') {
      const title = $('#t-title').value.trim();
      if (title) payload.title = title;
      const description = $('#t-description').value.trim();
      if (description) payload.description = description;
      const keywords = $('#t-keywords').value.split(',').map(k => k.trim()).filter(Boolean);
      if (keywords.length) payload.keywords = keywords;
      for (const [id, key] of [['t-category', 'category'], ['t-creator', 'creator'], ['t-copyright', 'copyright'], ['t-software', 'software'], ['t-profile', 'camera_profile']]) {
        const value = $(id).value.trim();
        if (value) payload[key] = value;
      }
      const city = $('#t-city').value.trim(), country = $('#t-country').value.trim();
      const lat = $('#t-lat').value, lon = $('#t-lon').value;
      if (city || country || lat !== '' || lon !== '') {
        payload.location = { lat: Number(lat || 0), lon: Number(lon || 0), city: city || 'Unknown', country: country || 'Unknown' };
      }
    }
    return { mode, payload };
  }

  function shellQuote(text) {
    return "'" + String(text).replace(/'/g, "'\\''") + "'";
  }

  function setupPlayground() {
    $('#test-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const { mode, payload } = buildTestPayload();
      const button = $('#test-submit');
      button.disabled = true;
      button.textContent = 'Running…';
      const result = await post('/api/admin/test', payload);
      button.disabled = false;
      button.textContent = 'Run request';

      $('#test-output').textContent = JSON.stringify(result.data, null, 2);
      const imageUrl = result.data?.metadata_image_url || result.data?.stripped_image_url;
      const preview = $('#test-preview');
      if (result.ok && imageUrl) {
        preview.innerHTML = `<img src="${esc(imageUrl)}" alt="Processed result">`;
        preview.hidden = false;
      } else {
        preview.hidden = true;
        preview.innerHTML = '';
      }

      state.lastCurl = `curl -X POST ${location.origin}/${mode} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer <YOUR_API_KEY>" \\\n  -d ${shellQuote(JSON.stringify(payload, null, 2))}`;
      $('#test-curl').textContent = state.lastCurl;
    });

    $('#copy-test-curl').onclick = () => copyText(state.lastCurl || 'Run a request first', 'cURL copied');
  }

  // ---------- docs ----------
  async function loadDocs() {
    if (!state.keys.length) {
      const result = await api('/api/admin/keys');
      if (result.ok) state.keys = result.data.items || [];
    }
    const usable = state.keys.filter(k => k.enabled);
    const key = usable.length ? usable[0].prefix + '…' : '<YOUR_API_KEY>';
    const curl = `curl -X POST ${location.origin}/embed-metadata \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '{
    "image_path": "https://example.com/photo.jpg",
    "title": "A beautiful sunset",
    "description": "Sunset over the mountains.",
    "keywords": ["sunset", "mountains", "nature"],
    "category": "Nature",
    "creator": "Your Name",
    "copyright": "© 2026 Your Name",
    "camera_profile": "sony-a7iv-85",
    "software": "Adobe Lightroom Classic 13.4.1",
    "location": { "lat": 48.8566, "lon": 2.3522, "city": "Paris", "country": "France" }
  }'`;
    $('#docs-body').innerHTML = `
      <div class="doc-grid">
        <div class="doc-item"><strong>POST /embed-metadata</strong>Embeds EXIF, XMP and IPTC metadata into a JPEG.</div>
        <div class="doc-item"><strong>POST /strip-metadata</strong>Removes EXIF, XMP, IPTC and COM segments. Only <code>image_path</code> is needed.</div>
        <div class="doc-item"><strong>GET /docs</strong>Raw markdown documentation.</div>
        <div class="doc-item"><strong>GET /health</strong>Liveness check for Coolify / Docker.</div>
      </div>
      <h3>Authentication</h3>
      <p class="muted">Every API call needs an API key generated in this dashboard, sent as <code>Authorization: Bearer &lt;key&gt;</code>. The admin key is only for this UI.</p>
      <h3>Parameters</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td class="mono">image_path</td><td>string</td><td>Yes</td><td>Public HTTP/HTTPS URL or Base64 image</td></tr>
          <tr><td class="mono">title</td><td>string</td><td>Embed only</td><td>Max 200 characters</td></tr>
          <tr><td class="mono">description</td><td>string</td><td>No</td><td>Max 2000 characters</td></tr>
          <tr><td class="mono">keywords</td><td>array</td><td>No</td><td>Max 50 strings</td></tr>
          <tr><td class="mono">category</td><td>string</td><td>No</td><td>Category label</td></tr>
          <tr><td class="mono">creator</td><td>string</td><td>No</td><td>Author / byline</td></tr>
          <tr><td class="mono">copyright</td><td>string</td><td>No</td><td>Copyright notice</td></tr>
          <tr><td class="mono">camera_profile</td><td>string</td><td>No</td><td><code>sony-a7iv-85</code>, <code>nikon-z8-35</code>, <code>canon-r5-50</code>, <code>fuji-xt5-23</code> — random if omitted</td></tr>
          <tr><td class="mono">software</td><td>string</td><td>No</td><td>Overrides the EXIF Software tag</td></tr>
          <tr><td class="mono">location</td><td>object</td><td>No</td><td><code>lat</code>, <code>lon</code>, <code>city</code>, <code>country</code> — random city if omitted</td></tr>
        </tbody>
      </table></div>
      <h3>Supported inputs</h3>
      <p class="muted">JPEG, PNG, WebP, GIF, BMP, TIFF. Output is always JPEG. Non-JPEG URLs are transcoded via wsrv.nl (q=99) before metadata is written.</p>
      <h3>Response URLs</h3>
      <p class="muted"><code>metadata_image_url</code> / <code>stripped_image_url</code> is the short-lived download link (~1h on tmpfiles.org). <code>long_lived_image_url</code> is a second link valid for ~48h (uguu.se), created by default — toggle it in Settings. For no expiry, use self-hosted storage with TTL <code>0</code> or move <code>catbox</code> to the top of the provider order.</p>
      <div class="code-head"><span>Example request</span><button class="btn btn-ghost btn-sm" data-copy-doc>Copy</button></div>
      <pre class="code-block">${esc(curl)}</pre>`;
    $('[data-copy-doc]').onclick = () => copyText(curl, 'cURL copied');
  }

  // ---------- boot ----------
  function setupModal() {
    $$('[data-close]').forEach(el => el.addEventListener('click', closeModal));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }

  async function boot() {
    setupAuth();
    setupNav();
    setupKeys();
    setupLogs();
    setupSettings();
    setupPlayground();
    setupModal();
    if (await checkSession()) await loadView();
  }

  boot();
})();
