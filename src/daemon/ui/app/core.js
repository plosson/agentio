// Shared state, calls to the daemon, rendering, and the pieces several screens use.

const $ = (id) => document.getElementById(id);
const main = $('main');

/** What the page knows. `results` are the tests the owner ran in this browser session. */
const state = {
  version: '',
  rows: [],
  keys: [],
  pending: [],
  results: new Map(),
  loaded: false,
  ui: {},
};

/** route view -> (route) => Raw markup. Each screen file registers its views. */
const VIEWS = {};
/** data-action -> handler(element, event), for clicks. */
const ACTIONS = {};
/** data-change -> handler(input, event), for checkboxes, radios and selects. */
const CHANGES = {};
/** data-submit -> handler(form, event), for forms. */
const SUBMITS = {};

const displayName = (service) => PLUGIN_METADATA[service]?.displayName || ICONS[service]?.[0] || service;
const isSession = (service) => Boolean(PLUGIN_METADATA[service]?.session);
const allRefs = () => state.rows.map(refOf).sort();
const rowByRef = (ref) => state.rows.find((r) => refOf(r) === ref);
const keyById = (id) => state.keys.find((k) => k.id === id);
/** `service/name` as the profile routes want it: each part encoded on its own. */
const refPath = (ref) => {
  const i = ref.indexOf('/');
  return `${encodeURIComponent(ref.slice(0, i))}/${encodeURIComponent(ref.slice(i + 1))}`;
};

function icon(service, cls = '') {
  const entry = ICONS[service];
  if (!entry) return html`<span class="ico letter ${cls}" aria-hidden="true">${(displayName(service)[0] || '?').toUpperCase()}</span>`;
  const [, fallbackColour, path] = entry;
  const colour = PLUGIN_METADATA[service]?.color || fallbackColour || 'currentColor';
  const shapes = Array.isArray(path)
    ? path.map(([fill, d]) => `<path fill="${escapeHtml(fill)}" d="${escapeHtml(d)}"/>`).join('')
    : `<path d="${escapeHtml(path)}"/>`;
  return raw(`<svg class="ico ${escapeHtml(cls)}" viewBox="0 0 24 24" fill="${escapeHtml(colour)}" aria-hidden="true">${shapes}</svg>`);
}

const profileLabel = (row) => html`<span class="svc">${icon(row.service)}${row.service} / ${row.profile}</span>`;

function pill(status, service) {
  const { label, tone } = statusPill(status, isSession(service));
  return html`<span class="pill ${tone}">${label}</span>`;
}

function copyButton(text) {
  return html`<button class="btn" type="button" data-action="copy" data-text="${text}">Copy</button>`;
}

// ---------- Talking to the daemon ----------

/**
 * One call to the owner API. A 401 or 503 means the session or the vault is
 * gone: the page goes back to the locked screen by itself and the call comes
 * back with `lost`, so a caller that forgets to check still lands right.
 */
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  } catch {
    return { ok: false, status: 0, body: null, lost: false, error: 'The hub did not answer. Check that it is running, then try again.' };
  }
  let body = null;
  if (res.status !== 204) {
    try { body = await res.json(); } catch { /* no body */ }
  }
  const lost = res.status === 401 || res.status === 503;
  if (lost) showUnlock();
  return { ok: res.ok, status: res.status, body, lost, error: (body && body.error) || `The hub answered ${res.status}.` };
}

/** Profiles (without testing them), machines and waiting sign-ins. */
async function loadAll() {
  const [status, keys, pending] = await Promise.all([api('/ui/api/status?test=false'), api('/ui/api/keys'), api('/ui/api/authorize')]);
  if (status.lost || keys.lost || pending.lost) return false;
  for (const res of [status, keys, pending]) if (!res.ok) toast(res.error, 'error');
  if (status.ok) {
    state.version = status.body.version || '';
    state.rows = Object.entries(status.body.services).flatMap(([service, list]) =>
      list.map((p) => ({ service, profile: p.profile, readOnly: Boolean(p.readOnly), status: p.status, info: p.info, error: p.error })));
  }
  if (keys.ok) state.keys = keys.body.keys;
  if (pending.ok) state.pending = pending.body.requests;
  state.loaded = true;
  return true;
}

async function loadPending() {
  const res = await api('/ui/api/authorize');
  if (res.ok) state.pending = res.body.requests;
}

/**
 * Tests the given profiles, three at a time, so each one reports as soon as
 * it is done. Only ever called when the owner asks.
 */
async function testProfiles(refs) {
  for (const ref of refs) state.results.set(ref, { status: 'testing', detail: '', at: Date.now() });
  render();
  const queue = refs.slice();
  const worker = async () => {
    for (let ref = queue.shift(); ref; ref = queue.shift()) {
      const res = await api(`/ui/api/profiles/${refPath(ref)}/status`);
      if (res.lost) return;
      const result = res.ok
        ? { status: res.body.status, detail: res.body.error || res.body.info || '', at: Date.now() }
        : { status: 'invalid', detail: res.error, at: Date.now() };
      state.results.set(ref, result);
      render();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------- Rendering ----------

function currentRoute() {
  return parseRoute(location.hash);
}

function go(route) {
  const hash = routeHash(route);
  if (location.hash === hash) render();
  else location.hash = hash;
}

function setTabs(route) {
  const tab = tabOf(route);
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
}

/** Draws the current route into #main. Views read `state`; nothing else writes to the page. */
function render() {
  if (!state.loaded) return;
  const route = currentRoute();
  const view = VIEWS[route.view] || VIEWS.overview;
  setTabs(route);
  $('bar').hidden = false;
  $('tabbar').hidden = route.view === 'authorize';
  $('hub-host').textContent = location.host;
  const focused = document.activeElement && document.activeElement.id;
  main.innerHTML = view(route).__html;
  if (focused && $(focused)) $(focused).focus();
}

// ---------- Feedback ----------

function toast(message, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

const clearToasts = () => { $('toasts').textContent = ''; };

/** Opens a <dialog> and resolves with the value of the button that closed it. */
function modal(id) {
  const dialog = $(id);
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
}

/** A specific question, its consequences, and the action repeated on the button. Focus starts on Cancel. */
async function confirmDialog({ title, body, action }) {
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = action;
  return (await modal('confirm-dialog')) === 'ok';
}

async function renameDialog(current, label) {
  $('rename-title').textContent = `Rename ${label}`;
  $('rename-input').value = current;
  const result = await modal('rename-dialog');
  const value = $('rename-input').value.trim();
  return result === 'ok' && value && value !== current ? value : null;
}

/** The key is shown once, as the two ways to use it. */
function showToken(token) {
  const quoted = shellQuote(token);
  $('token-save-cmd').textContent = `(umask 077 && mkdir -p ~/.config/agentio && printf '%s\\n' ${quoted} > ~/.config/agentio/token)`;
  $('token-env-cmd').textContent = `export AGENTIO_TOKEN=${quoted}`;
  const dialog = $('token-dialog');
  dialog.addEventListener('close', () => { $('token-save-cmd').textContent = ''; $('token-env-cmd').textContent = ''; }, { once: true });
  dialog.showModal();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed: select the text and copy it by hand.', 'error');
  }
}

ACTIONS.copy = (el) => copyText(el.dataset.text);
document.addEventListener('click', (ev) => {
  const from = ev.target.closest('[data-copy-from]');
  if (from) copyText($(from.dataset.copyFrom).textContent);
});

// ---------- Access choices (sign-in step 2, connect a machine, change a machine) ----------

/** Checkboxes for every profile, grouped by service. `selected` is '*' or a list of refs. */
function profileChecks(prefix, selected) {
  const groups = groupProfiles(state.rows, displayName);
  return html`<div class="checks" id="${prefix}-checks">${groups.map((g) => g.rows.map((r) => html`
    <label><input type="checkbox" name="${prefix}-ref" value="${refOf(r)}" ${selected === '*' || selected.includes(refOf(r)) ? raw('checked') : ''}>${profileLabel(r)}</label>`))}</div>`;
}

/** "All profiles" or "Choose profiles…", for changing what a machine can use. */
function profileChooser(prefix, selected) {
  const all = selected === '*';
  return html`
    <label class="radio"><input type="radio" name="${prefix}-scope" value="all" ${all ? raw('checked') : ''} data-change="scope-mode">
      <div><b>All profiles</b><div class="muted">Including profiles added later</div></div></label>
    <label class="radio"><input type="radio" name="${prefix}-scope" value="some" ${all ? '' : raw('checked')} data-change="scope-mode">
      <div class="grow"><b>Choose profiles…</b>${profileChecks(prefix, all ? [] : selected)}</div></label>`;
}

function readProfileChoice(form, prefix) {
  if (form.querySelector(`input[name="${prefix}-scope"]:checked`).value === 'all') return '*';
  return [...form.querySelectorAll(`input[name="${prefix}-ref"]:checked`)].map((i) => i.value);
}

/** The three presets. "Read everything" is the default (read-only). */
function accessChooser(prefix) {
  const others = [...state.keys].sort((a, b) => a.name.localeCompare(b.name));
  return html`
    <label class="radio"><input type="radio" name="${prefix}-preset" value="read-all" checked>
      <div><b>Read everything</b><div class="muted">All ${plural(state.rows.length, 'profile')}, read-only</div></div></label>
    ${others.length ? html`<label class="radio"><input type="radio" name="${prefix}-preset" value="same-as">
      <div class="grow"><b>Same as…</b><div class="muted">Copies another machine's profiles and settings</div>
      <select name="${prefix}-same" aria-label="Machine to copy">${others.map((k) => html`<option value="${k.id}">${k.name}</option>`)}</select></div></label>` : ''}
    <label class="radio"><input type="radio" name="${prefix}-preset" value="choose">
      <div class="grow"><b>Choose profiles…</b><div class="muted">Tick each one</div>
      ${profileChecks(prefix, [])}
      <label class="row mt-6"><input type="checkbox" name="${prefix}-ro" checked> Read-only</label></div></label>`;
}

/** The chosen preset, ready for `presetInput`. */
function readAccessChoice(form, prefix) {
  const kind = form.querySelector(`input[name="${prefix}-preset"]:checked`).value;
  if (kind === 'same-as') return { kind, key: keyById(form.querySelector(`select[name="${prefix}-same"]`).value) };
  if (kind === 'choose') {
    return {
      kind,
      refs: [...form.querySelectorAll(`input[name="${prefix}-ref"]:checked`)].map((i) => i.value),
      readOnly: form.querySelector(`input[name="${prefix}-ro"]`).checked,
    };
  }
  return { kind: 'read-all' };
}

CHANGES['scope-mode'] = () => {};
