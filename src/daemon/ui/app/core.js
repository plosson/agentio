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
/** data-input -> handler(input, event), for text typed into a field. */
const INPUTS = {};

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
 * back with `lost`, so a caller that forgets to check still lands right. The
 * one exception is the unlock request itself: its own 401 is a wrong
 * passphrase, not a lost session, so it never counts as `lost` and the
 * caller shows it inline instead.
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
  // A 401 from the unlock attempt itself is a wrong passphrase, not a lost session: the caller shows it inline.
  const lost = path !== '/ui/api/unlock' && (res.status === 401 || res.status === 503);
  if (lost) {
    if (res.status === 503) {
      showUnlock(true);
    } else {
      // A 401 elsewhere means this browser has no session; that can happen with the vault
      // either unlocked or locked, so ask rather than assume the alarming case.
      const probe = await fetch('/ui/api/session').then((r) => r.json()).catch(() => null);
      showUnlock(probe ? probe.locked : false);
    }
  }
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
      list.map((p) => ({ service, profile: p.profile, readOnly: Boolean(p.readOnly), status: p.status, info: p.info, error: p.error, account: p.account, url: p.url })));
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
 * True while the owner is filling a form that a redraw would clobber: step 2
 * of a sign-in, a machine's "Connect a machine" panel, or its scope editor.
 */
function formOpen() {
  const route = currentRoute();
  if (route.view === 'authorize') return true;
  if (route.view === 'machines' && state.ui.connectOpen) return true;
  if (route.view === 'machine' && state.ui.editScope) return true;
  return false;
}

/**
 * Tests the given profiles, three at a time, so each one reports as soon as
 * it is done. Only ever called when the owner asks. Results are stored as
 * they arrive, but the page is redrawn only once at the end, and not at all
 * over a form the owner is filling in (the next redraw picks up the results).
 */
async function testProfiles(refs) {
  for (const ref of refs) state.results.set(ref, { status: 'testing', detail: '', at: Date.now() });
  render();
  const queue = refs.slice();
  let lost = false;
  const worker = async () => {
    for (let ref = queue.shift(); ref; ref = queue.shift()) {
      const res = await api(`/ui/api/profiles/${refPath(ref)}/status`);
      if (res.lost) { lost = true; return; }
      const result = res.ok
        ? { status: res.body.status, detail: res.body.error || res.body.info || '', at: Date.now() }
        : { status: 'invalid', detail: res.error, at: Date.now() };
      state.results.set(ref, result);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (lost) {
    // The session or vault went away mid-run: drop results still stuck on 'testing' so
    // they do not claim to be testing forever once the owner is back.
    for (const ref of refs) if (state.results.get(ref)?.status === 'testing') state.results.delete(ref);
    return;
  }
  if (!formOpen()) render();
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
  const view = VIEWS[route.view] || VIEWS.profiles;
  setTabs(route);
  $('bar').hidden = false;
  $('tabbar').hidden = route.view === 'authorize';
  $('hub-host').textContent = location.host;
  // Redrawing replaces every element: put focus, and the caret of a text field, back where they were.
  const active = document.activeElement;
  const focused = active && active.id;
  const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  main.innerHTML = (route.view === 'authorize' ? '' : signInBanner().__html) + view(route).__html;
  const again = focused && $(focused);
  if (!again) return;
  again.focus();
  if (caret && typeof again.setSelectionRange === 'function') again.setSelectionRange(caret[0], caret[1]);
}

// ---------- Waiting sign-ins ----------

/**
 * A machine waiting for approval is the one thing that cannot wait, so it shows
 * on every page (not on the approval page itself). Oldest first, as the daemon lists them.
 */
function signInBanner() {
  const now = Date.now();
  return html`${state.pending.map((req) => html`<div class="box hl row mb-12"><span class="grow"><b>${req.name} wants access</b> · code ${req.userCode} · asked ${relativeTime(req.createdAt, now)}</span>
    <button class="btn" data-action="deny-sign-in" data-code="${req.userCode}">Deny</button>
    <a class="btn pri" href="${routeHash({ view: 'authorize', code: req.userCode })}">Review</a></div>`)}`;
}

ACTIONS['deny-sign-in'] = async (el) => {
  const res = await api(`/ui/api/authorize/${encodeURIComponent(el.dataset.code)}`, { method: 'POST', body: JSON.stringify({ approve: false }) });
  if (res.lost) return;
  if (res.ok || res.status === 404) toast(res.ok ? 'Denied. The terminal is told no.' : 'That request had already ended.');
  else toast(res.error, 'error');
  await loadPending();
  render();
};

// ---------- Filtering profiles (Profiles, Who can use what) ----------

/** The rows that match the filter box; the filter is kept across screens for the session. */
const filteredRows = (rows) => rows.filter((r) => matchesFilter(r, state.ui.filter || '', displayName));

/** The filter box, and how many of the profiles it shows when it hides some. */
function filterBox(shown, total) {
  const query = state.ui.filter || '';
  return html`<div class="row mt-12">
    <input type="search" id="profile-filter" class="filter grow" data-input="filter" value="${query}"
      placeholder="Filter profiles (press /)" aria-label="Filter profiles" autocomplete="off" spellcheck="false">
    ${query.trim() ? html`<span class="muted">Showing ${shown} of ${plural(total, 'profile')}</span>` : ''}
  </div>`;
}

/** What a filtered screen shows when nothing matches. */
const noMatch = () => html`<div class="box empty mt-12"><p>No profile matches “${state.ui.filter}”.</p><button class="btn" data-action="clear-filter">Clear filter</button></div>`;

INPUTS.filter = (input) => { state.ui.filter = input.value; render(); };
ACTIONS['clear-filter'] = () => { state.ui.filter = ''; render(); };

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
      <div class="grow"><b>Choose profiles…</b>${profileChecks(prefix, selected)}</div></label>`;
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
