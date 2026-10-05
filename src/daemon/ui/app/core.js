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

/** list name ('profiles' | 'machines') -> (route) => Raw markup for the list pane. See paneOf. */
const LISTS = {};
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

/** A service's logo in white on its colour, as a rounded square: the lead of a profile row, and the top of its page. */
function tile(service, cls = '') {
  const entry = ICONS[service];
  const colour = PLUGIN_METADATA[service]?.color || entry?.[1] || '';
  const shapes = !entry
    ? `<text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700">${escapeHtml((displayName(service)[0] || '?').toUpperCase())}</text>`
    : Array.isArray(entry[2])
      ? entry[2].map(([, d]) => `<path d="${escapeHtml(d)}"/>`).join('')
      : `<path d="${escapeHtml(entry[2])}"/>`;
  // Shapes are drawn at 24 units and shrunk to leave a margin; without a colour, the tile is grey (admin.css).
  return raw(`<svg class="svc-tile ${escapeHtml(cls)}" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.5"${colour ? ` fill="${escapeHtml(colour)}"` : ''}/><g fill="white" transform="translate(5 5) scale(0.5833)">${shapes}</g></svg>`);
}

/** Toolbar symbols, drawn in the text colour. */
const GLYPHS = {
  reload: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  add: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.7"/>',
  grid: '<path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  search: '<circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 11l4 4" stroke="currentColor" stroke-width="2"/>',
};
function glyph(name) {
  return raw(`<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">${GLYPHS[name]}</svg>`);
}

const profileLabel = (row) => html`<span class="svc">${icon(row.service)}${row.service} / ${row.profile}</span>`;

/** A status as symbol and word, coloured by tone. The symbol is decoration; the word carries the meaning. */
function statusMarkup(sw) {
  return html`<span class="status ${sw.tone}"><span aria-hidden="true">${sw.symbol}</span> ${sw.word}</span>`;
}

function statusText(status, service) {
  return statusMarkup(statusWord(status, isSession(service)));
}

function copyButton(text) {
  return html`<button class="button" type="button" data-action="copy" data-text="${text}">Copy</button>`;
}

/** A command people copy: monospace, wrapping, with its Copy button. */
function command(text) {
  return html`<div class="command"><code>${text}</code>${copyButton(text)}</div>`;
}

// ---------- Components (brand document, section 06): each exists once ----------

/** The dark panel holding the one value the owner came for. At most one per screen. */
function displayPanel(label, value, second) {
  return html`<div class="display"><span class="label">${label}</span><span class="value">${value}</span>${second ? html`<span class="second">${second}</span>` : ''}</div>`;
}

/**
 * The head of a pane: a back link (shown on a narrow window only, where the sidebar and the list are
 * out of sight), the H1 with its count after it, and the pane's actions. It stays at the top while the
 * pane scrolls. With `rename`, the H1 can be edited in place: Enter saves, Esc cancels.
 */
function pageHead({ path = [], title, count, actions = '', rename = null }) {
  const up = [...path].reverse().find((p) => p.href);
  const back = up ? html`<a class="back" href="${up.href}"><span aria-hidden="true">‹</span> ${up.label}</a>` : '';
  const editing = rename && state.ui.renaming === rename.key;
  const heading = editing
    ? html`<form class="inline-edit" data-submit="${rename.submit}" data-key="${rename.key}" novalidate>
        <label class="sr-only" for="rename-input">New name</label>
        <input class="input" id="rename-input" name="name" value="${state.ui.renameDraft ?? title}" data-input="rename" maxlength="64" autocomplete="off" spellcheck="false"
          ${state.ui.renameError ? raw('aria-invalid="true" aria-describedby="rename-error"') : ''}>
        <button class="button">Save</button>
        <button type="button" class="button link" data-action="cancel-rename">Cancel</button>
        ${state.ui.renameError ? html`<span class="field-error" id="rename-error" role="alert">✗ ${state.ui.renameError}</span>` : ''}
      </form>`
    : html`<div class="title"><h1>${title}</h1>${count === undefined ? '' : html`<span class="count">${count}</span>`}
        ${rename ? html`<button type="button" class="button link" data-action="start-rename" data-key="${rename.key}">Rename</button>` : ''}</div>`;
  return html`<div class="pane-head">${back}${heading}${actions}</div>`;
}

ACTIONS['start-rename'] = (el) => {
  state.ui.renaming = el.dataset.key;
  state.ui.renameError = '';
  state.ui.renameDraft = undefined;
  render();
  const input = $('rename-input');
  if (input) { input.focus(); input.select(); }
};

/** Keep what was typed, so any redraw (a banner, a refresh) puts it back. */
INPUTS.rename = (input) => { state.ui.renameDraft = input.value; };

ACTIONS['cancel-rename'] = () => {
  state.ui.renaming = null;
  state.ui.renameError = '';
  state.ui.renameDraft = undefined;
  render();
};

/**
 * One list row: an optional lead (a service tile), a bold title, a muted message, small meta, and a dot.
 * `dot` is true or false (new or active, or not), or a status word, whose word screen readers read.
 * A link with `href`; `current` marks the row whose details are open.
 */
function listItem({ href, dot, lead = '', title, message = '', meta = '', current = false }) {
  const cls = `item${dot === undefined ? ' no-dot' : ''}${lead ? ' lead' : ''}`;
  const mark = dot === undefined ? ''
    : typeof dot === 'object'
      ? html`<span class="dot ${dot.tone}" title="${dot.word}" aria-hidden="true"></span><span class="sr-only">${dot.word}</span>`
      : html`<span class="dot ${dot ? 'new' : ''}" aria-hidden="true"></span>`;
  const body = html`${lead}${mark}<span>
    <span class="item-title">${title}</span>${message ? html`<span class="item-message">${message}</span>` : ''}${meta ? html`<span class="item-meta">${meta}</span>` : ''}</span>`;
  return href
    ? html`<li><a class="${cls}" href="${href}"${current ? raw(' aria-current="page"') : ''}>${body}</a></li>`
    : html`<li><div class="${cls}">${body}</div></li>`;
}

/** One sentence at the top of the page, then the next action. `problem` uses the warning background. */
function banner(text, actions = '', problem = false) {
  return html`<div class="banner ${problem ? 'problem' : ''}"><span class="text">${text}</span>${actions}</div>`;
}

/** What will appear here, and how to get it. */
function emptyState(text, actions = '') {
  return html`<div class="empty-state"><p>${text}</p>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;
}

/** Two to four views of the same data. `items` are { id, href, label }. */
function segmented(items, current) {
  return html`<nav class="segmented" aria-label="View">${items.map((i) => html`<a href="${i.href}" ${i.id === current ? raw('aria-current="page"') : ''}>${i.label}</a>`)}</nav>`;
}

/** Not found, ended, unreachable: what happened, why in one sentence, the one way out. */
function systemPage({ title, why, action, details = '' }) {
  return html`<div class="narrow system"><h1>${title}</h1><p class="lede mt-8">${why}</p><div class="actions">${action}</div>${details}</div>`;
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
  if (!state.loaded && status.status === 0) { showUnreachable(); return false; }
  for (const res of [status, keys, pending]) if (!res.ok) toast(res.error, 'error');
  if (status.ok) {
    state.version = status.body.version || '';
    state.rows = Object.entries(status.body.services).flatMap(([service, list]) =>
      list.map((p) => ({ service, profile: p.profile, readOnly: Boolean(p.readOnly), status: p.status, info: p.info, error: p.error, account: p.account, url: p.url })));
  }
  if (keys.ok) state.keys = keys.body.keys;
  if (pending.ok) state.pending = pending.body.requests;
  state.loaded = true;
  state.loadedAt = Date.now();
  return true;
}

async function loadPending() {
  const res = await api('/ui/api/authorize');
  if (res.ok) state.pending = res.body.requests;
}

/** No answer from the hub before anything loaded: a system page, not a blank screen. */
function showUnreachable() {
  showChrome(false);
  main.innerHTML = systemPage({
    title: 'The hub did not answer',
    why: 'Check that it is running and that this computer can reach it.',
    action: html`<button class="button primary" data-action="retry">Try again</button>`,
    details: state.loadedAt ? html`<p class="muted small">Last loaded at ${clockTime(state.loadedAt)}.</p>` : '',
  }).__html;
  setTitle();
}

ACTIONS.retry = () => location.reload();

/**
 * True while the owner is filling a form that a redraw would clobber: step 2
 * of a sign-in, a machine's "Connect a machine" panel, or its scope editor.
 */
function formOpen() {
  if (state.ui.renaming) return true;
  const route = currentRoute();
  if (route.view === 'authorize') return true;
  if (route.view === 'connect' && state.ui.byHand) return true;
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
      // Each result shows as soon as it arrives, not when the slowest profile is done.
      if (!formOpen()) render();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (lost) {
    // The session or vault went away mid-run: drop results still stuck on 'testing' so
    // they do not claim to be testing forever once the owner is back.
    for (const ref of refs) if (state.results.get(ref)?.status === 'testing') state.results.delete(ref);
  }
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

/** The browser title follows the H1, as "Profiles · agentio". */
function setTitle() {
  const h1 = main.querySelector('h1');
  if (h1) document.title = `${h1.textContent.trim()} · agentio`;
}

/** The sidebar and the list show once the hub is open; the gate and system pages fill the window alone. */
function showChrome(on) {
  $('shell').classList.toggle('bare', !on);
  $('bar').hidden = !on;
  if (on) return;
  $('shell').classList.remove('no-list', 'selected');
  $('list').textContent = '';
  $('list').dataset.list = '';
}

/** Draws the current route: its list (if any) into #list, its details into #main. Views read `state`; nothing else writes to the page. */
function render() {
  if (!state.loaded) return;
  const route = currentRoute();
  const view = VIEWS[route.view] || VIEWS.overview;
  const panes = paneOf(route);
  const lister = panes.list && LISTS[panes.list];
  setTabs(route);
  showChrome(true);
  $('shell').classList.toggle('no-list', !lister);
  $('shell').classList.toggle('selected', panes.selected);
  $('profiles-count').textContent = state.rows.length ? String(state.rows.length) : '';
  $('machines-count').textContent = state.keys.length ? String(state.keys.length) : '';
  $('version').textContent = state.version ? `v${state.version}` : '';
  $('hub-host').textContent = location.host;
  // Redrawing replaces every element: put focus, and the caret of a text field, back where they were.
  const active = document.activeElement;
  const focused = active && active.id;
  const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  // The same list keeps its scroll when a row is chosen; another list starts at the top.
  const list = $('list');
  const keep = list.dataset.list === (panes.list || '') ? list.scrollTop : 0;
  list.innerHTML = lister ? lister(route).__html : '';
  list.dataset.list = lister ? panes.list : '';
  list.scrollTop = keep;
  main.innerHTML = view(route).__html;
  const pending = route.view === 'authorize' ? '' : signInBanner().__html;
  const head = main.querySelector(':scope > .pane-head');
  if (head) head.insertAdjacentHTML('afterend', pending);
  else main.insertAdjacentHTML('afterbegin', pending);
  setTitle();
  syncCountdowns();
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
  return html`${state.pending.map((req) => banner(
    html`<span aria-hidden="true">!</span> <b>${req.name}</b> wants access · code <span class="mono">${req.userCode}</span> · <span data-countdown="${req.expiresAt}">${countdown(req.expiresAt, now)}</span>`,
    html`<button class="button" data-action="deny-sign-in" data-code="${req.userCode}">Deny</button>
      <a class="button" href="${routeHash({ view: 'authorize', code: req.userCode })}">Review</a>`,
    true))}`;
}

/** One timer while a countdown is on screen; it updates the text only, never redraws. */
let ticker = null;

function tick() {
  const now = Date.now();
  const live = document.querySelectorAll('[data-countdown]');
  if (live.length === 0) { clearInterval(ticker); ticker = null; return; }
  let ended = false;
  live.forEach((el) => {
    const text = countdown(el.dataset.countdown, now);
    el.textContent = text;
    if (text === 'ended') ended = true;
  });
  // The request ran out on the approval screen: say so instead of letting Approve fail.
  if (ended && currentRoute().view === 'authorize' && state.ui.auth && state.ui.auth.step === 'ask' && !state.ui.auth.busy) {
    Object.assign(state.ui.auth, { step: 'error', ended: true, error: ENDED });
    render();
  }
}

function syncCountdowns() {
  const any = document.querySelector('[data-countdown]');
  if (any && !ticker) ticker = setInterval(tick, 1000);
  if (!any && ticker) { clearInterval(ticker); ticker = null; }
}

ACTIONS['deny-sign-in'] = async (el) => {
  if (el.disabled) return;
  el.disabled = true;
  const res = await api(`/ui/api/authorize/${encodeURIComponent(el.dataset.code)}`, { method: 'POST', body: JSON.stringify({ approve: false }) });
  if (res.lost) return;
  if (res.ok || res.status === 404) toast(res.ok ? 'Denied. The terminal is told no.' : 'That request had already ended.');
  else { toast(res.error, 'error'); el.disabled = false; }
  await loadPending();
  // Over a form the owner is filling, only this banner goes; a redraw would wipe what they typed.
  if (formOpen()) el.closest('.banner')?.remove();
  else render();
};

// ---------- Filtering profiles (Profiles, Who can use what) ----------

/** The rows that match the filter box; the filter is kept across screens for the session. */
const filteredRows = (rows) => rows.filter((r) => matchesFilter(r, state.ui.filter || '', displayName));

function filterBox(shown, total) {
  const query = state.ui.filter || '';
  return html`<div class="search">${glyph('search')}
    <input type="search" id="profile-filter" class="input" data-input="filter" value="${query}"
      placeholder="Search (press /)" aria-label="Filter profiles" autocomplete="off" spellcheck="false">
    ${query.trim() ? html`<span class="muted small">Showing ${shown} of ${plural(total, 'profile')}</span>` : ''}
  </div>`;
}

const noMatch = () => emptyState(html`No profile matches “${state.ui.filter}”.`, html`<button class="button" data-action="clear-filter">Clear filter</button>`);

INPUTS.filter = (input) => { state.ui.filter = input.value; render(); };
ACTIONS['clear-filter'] = () => { state.ui.filter = ''; render(); };

// ---------- Feedback ----------

function toast(message, kind, link) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    el.appendChild(a);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
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

/** The question asked before leaving a key nobody has copied. One definition for every way out. */
const LEAVE_KEY = {
  title: 'Leave without copying the key?',
  body: "It isn't shown again. If you leave now, you'll have to replace the key.",
  action: 'Leave',
};

/** True when leaving is fine: no key is on screen, it was copied, or the owner chose to leave. */
async function confirmLeaveKey() {
  const key = state.ui.shownKey;
  if (!key || key.copied) return true;
  return confirmDialog(LEAVE_KEY);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
    if (state.ui.shownKey) state.ui.shownKey.copied = true;
  } catch {
    toast('Copy failed: select the text and copy it by hand.', 'error');
  }
}

ACTIONS.copy = (el) => copyText(el.dataset.text);

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
    <label class="radio-card"><input type="radio" name="${prefix}-scope" value="all" ${all ? raw('checked') : ''}>
      <span><span class="title">All profiles</span><span class="help">Including profiles added later</span></span></label>
    <label class="radio-card"><input type="radio" name="${prefix}-scope" value="some" ${all ? '' : raw('checked')}>
      <span class="grow"><span class="title">Choose profiles…</span>${profileChecks(prefix, selected)}</span></label>`;
}

function readProfileChoice(form, prefix) {
  if (form.querySelector(`input[name="${prefix}-scope"]:checked`).value === 'all') return '*';
  return [...form.querySelectorAll(`input[name="${prefix}-ref"]:checked`)].map((i) => i.value);
}

/** The three presets. "Read everything" is the default (read-only). */
function accessChooser(prefix) {
  const others = [...state.keys].sort((a, b) => a.name.localeCompare(b.name));
  return html`
    <label class="radio-card"><input type="radio" name="${prefix}-preset" value="read-all" checked>
      <span><span class="title">Read everything</span><span class="help">All ${plural(state.rows.length, 'profile')}, read-only</span></span></label>
    ${others.length ? html`<label class="radio-card"><input type="radio" name="${prefix}-preset" value="same-as">
      <span class="grow"><span class="title">Same as…</span><span class="help">Copies another machine's profiles and settings</span>
      <select class="input mt-8" name="${prefix}-same" aria-label="Machine to copy">${others.map((k) => html`<option value="${k.id}">${k.name}</option>`)}</select></span></label>` : ''}
    <label class="radio-card"><input type="radio" name="${prefix}-preset" value="choose">
      <span class="grow"><span class="title">Choose profiles…</span><span class="help">Tick each one</span>
      ${profileChecks(prefix, [])}
      <label class="check"><input type="checkbox" name="${prefix}-ro" checked> Read-only</label></span></label>`;
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
