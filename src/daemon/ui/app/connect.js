// Connect a machine: the card on the Overview and on the Connect page, then the key shown
// once after creating or replacing one by hand.

/** The computer glyph the machine rows and the empty slot share. */
const MACHINE_GLYPH = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12v8H2zM5 13h6v1H5z"/></svg>`;

/**
 * Asking an agent or running the commands, the machines waiting for approval, and the one just
 * connected. `compact` folds it to one line once the hub has machines and nothing is waiting.
 */
function connectCard({ compact = false } = {}) {
  const connected = state.ui.connected;
  if (compact && !state.pending.length && !connected && !state.ui.connectOpen) {
    return html`<section class="connect-card folded" data-waiting>
      <img src="/ui/icon.svg?v=${state.version}" alt="">
      <div class="grow"><b>Connect another machine</b><span>Paste one sentence into your agent, or run two commands.</span></div>
      <button type="button" class="button" data-action="connect-open">Show how</button></section>`;
  }
  const tab = state.ui.connectTab === 'hand' ? 'hand' : 'agent';
  return html`<section class="connect-card" aria-labelledby="connect-title">
    <div class="hello"><img src="/ui/icon.svg?v=${state.version}" alt="">
      <div><h2 id="connect-title">${state.keys.length ? 'Connect another machine' : 'Let your agents use this vault'}</h2>
        <p class="lede">Connect the computer where your agents run. They use the profiles here through agentio, without ever seeing their passwords or keys.</p></div></div>
    <div class="seg" role="tablist" aria-label="How to connect" data-on="${tab}">
      <span class="thumb" aria-hidden="true"></span>
      <button type="button" role="tab" data-action="connect-tab" data-tab="agent" aria-selected="${tab === 'agent'}">Ask your agent</button>
      <button type="button" role="tab" data-action="connect-tab" data-tab="hand" aria-selected="${tab === 'hand'}">Do it yourself</button>
    </div>
    <div class="connect-panel" role="tabpanel">${connectPanel(tab)}</div>
    ${connectLive(connected)}
    ${compact && state.ui.connectOpen && !state.pending.length ? html`<div class="actions"><button type="button" class="button link" data-action="connect-close">Hide</button></div>` : ''}
  </section>`;
}

function connectPanel(tab) {
  if (tab === 'hand') {
    return html`<p class="who">On the computer where your agents run, in a terminal.</p>
      <ol class="steps">
        <li><span><b>Install agentio</b>${command(INSTALL_COMMAND)}</span></li>
        <li><span><b>Connect it to this vault</b>${command(loginCommand(location.origin))}</span></li>
        <li><span><b>Approve the code it shows</b><span class="muted">The request appears here. Nothing to copy back.</span></span></li>
      </ol>`;
  }
  const prompt = connectPrompt(location.origin);
  return html`<p class="who">For an agent that can run commands: <b>Claude Code, Codex, Cursor</b> and others.</p>
    <div class="prompt"><p>${prompt}</p>
      <div class="actions"><button type="button" class="button primary" data-action="copy" data-text="${prompt}">Copy</button>
        <span class="muted">Paste it into your agent.</span></div></div>
    <p class="note">Your agent installs agentio, then its machine asks to connect. You approve the request here.
      <a href="/install.md" target="_blank" rel="noopener noreferrer">See what it reads</a></p>`;
}

/** Below the steps: who waits for approval, who just connected, or that the page is waiting. */
function connectLive(connected) {
  if (state.pending.length) {
    const now = Date.now();
    const seen = state.ui.seenRequests || (state.ui.seenRequests = new Set());
    const rows = state.pending.map((req) => {
      const fresh = !seen.has(req.userCode);
      seen.add(req.userCode);
      return html`<div class="request${fresh ? ' arrived' : ''}" role="alert">
        <span class="request-icon">${MACHINE_GLYPH}</span>
        <span class="grow"><b>${req.name} wants to connect</b>
          <span class="muted">Check that it shows the same code: </span><span class="code">${req.userCode}</span>
          <span class="muted"> · <span data-countdown="${req.expiresAt}">${countdown(req.expiresAt, now)}</span></span></span>
        <span class="actions"><button type="button" class="button" data-action="deny-sign-in" data-code="${req.userCode}">Deny</button>
          <a class="button primary" href="${routeHash({ view: 'authorize', code: req.userCode })}">Approve…</a></span></div>`;
    });
    return html`${rows}`;
  }
  if (connected) {
    return html`<p class="connected"><svg class="check" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="12"/><path d="M8.5 14.5l3.5 3.5 7.5-8"/></svg>${connected} is connected. Its agents can use the vault now.</p>`;
  }
  return html`<p class="waiting" data-waiting><span class="pulse" aria-hidden="true"></span>Waiting for a machine to connect…</p>`;
}

/** The tab changes in place, so the highlight slides instead of the card being redrawn. */
ACTIONS['connect-tab'] = (el) => {
  const tab = el.dataset.tab === 'hand' ? 'hand' : 'agent';
  if (state.ui.connectTab === tab) return;
  state.ui.connectTab = tab;
  const seg = el.closest('.seg');
  seg.dataset.on = tab;
  seg.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  seg.parentElement.querySelector('.connect-panel').innerHTML = connectPanel(tab).__html;
};

ACTIONS['connect-open'] = () => { state.ui.connectOpen = true; render(); };
ACTIONS['connect-close'] = () => { state.ui.connectOpen = false; render(); };

/**
 * While the connect card is on screen, folded or not, ask the hub every few seconds who waits for approval. A request
 * that goes away may have been approved elsewhere: the machines reload, and a new one is greeted.
 */
const WAIT_POLL_MS = 3000;
let waitPoll = null;

function syncWaiting() {
  const waiting = Boolean(document.querySelector('[data-waiting], .request'));
  if (waiting && !waitPoll) waitPoll = setInterval(pollWaiting, WAIT_POLL_MS);
  if (!waiting && waitPoll) { clearInterval(waitPoll); waitPoll = null; }
}

async function pollWaiting() {
  if (document.visibilityState !== 'visible' || formOpen()) return;
  const before = state.pending.map((r) => r.userCode).join(' ');
  const known = new Set(state.keys.map((k) => k.id));
  await loadPending();
  if (state.pending.map((r) => r.userCode).join(' ') === before) return;
  if (before) {
    const keys = await api('/ui/api/keys');
    if (keys.ok) {
      state.keys = keys.body.keys;
      greetNewMachine(state.keys.find((k) => !known.has(k.id)));
    }
  }
  render();
}

/** A machine connected while the owner watched: say so in the card and slide it into the list. */
function greetNewMachine(key) {
  if (!key) return;
  state.ui.connected = key.name;
  state.ui.justConnected = key.id;
}

VIEWS.connect = () => html`
  ${pageHead({ path: [{ href: '#machines', label: 'Machines' }], title: 'Connect a machine' })}
  <div class="readable">
    ${connectCard()}
    <details id="by-hand" class="mt-24" ${state.ui.byHand ? raw('open') : ''}>
      <summary class="button link">Advanced: create a key by hand</summary>
      <form class="mt-16" data-submit="create-key" novalidate>
        <label class="form-field"><span class="label">Name</span>
          <input class="input mono" type="text" name="name" id="key-name" placeholder="e.g. laptop, ci, build-box" maxlength="64" autocomplete="off" spellcheck="false" aria-describedby="key-name-error">
          <span class="help">How you will recognise this machine.</span></label>
        <span id="key-name-error" class="field-error" role="alert" hidden></span>
        <fieldset class="plain"><legend class="label">What it can use</legend>${accessChooser('create')}</fieldset>
        <div class="actions"><a class="button" href="#machines">Cancel</a><button class="button primary">Create key</button></div>
      </form>
    </details>
  </div>`;

SUBMITS['create-key'] = async (form) => {
  const field = form.elements.name;
  const name = field.value.trim();
  const err = $('key-name-error');
  err.hidden = true;
  field.removeAttribute('aria-invalid');
  if (!name) {
    err.textContent = '✗ Give the machine a name.';
    err.hidden = false;
    field.setAttribute('aria-invalid', 'true');
    field.focus();
    return;
  }
  let input;
  try {
    input = presetInput(readAccessChoice(form, 'create'), name);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const button = form.querySelector('.button.primary');
  button.disabled = true;
  button.textContent = 'Creating…';
  const res = await api('/ui/api/keys', { method: 'POST', body: JSON.stringify({ ...input, url: location.origin }) });
  if (res.lost) return;
  if (!res.ok) { button.disabled = false; button.textContent = 'Create key'; toast(res.error, 'error'); return; }
  state.keys = [...state.keys, res.body.key];
  state.ui.byHand = false;
  showKey(res.body.key, res.body.token, 'created');
};

/** Opens the shown-once page. The key lives in memory only, and only until the owner leaves the page. */
function showKey(key, token, how) {
  state.ui.shownKey = { id: key.id, name: key.name, token, how, copied: false };
  go({ view: 'key' });
}

VIEWS.key = () => {
  const shown = state.ui.shownKey;
  if (!shown) {
    return systemPage({ title: 'Nothing to show', why: 'A key is shown only once, right after it is created or replaced.', action: html`<a class="button" href="#machines">Back to machines</a>` });
  }
  const quoted = shellQuote(shown.token);
  const save = `(umask 077 && mkdir -p ~/.config/agentio && printf '%s\\n' ${quoted} > ~/.config/agentio/token)`;
  const env = `export AGENTIO_TOKEN=${quoted}`;
  return html`
    ${pageHead({ path: [{ href: '#machines', label: 'Machines' }, { href: routeHash({ view: 'machine', id: shown.id }), label: shown.name }], title: shown.how === 'replaced' ? 'Key replaced' : 'Key created' })}
    <div class="readable">
      <p><b>This key is shown once.</b> If it is lost, replace it. On ${shown.name}, after installing agentio, run one of these.</p>
      <h2>Save it for this user</h2>${command(save)}
      <h2>Or for one shell or a CI job</h2>${command(env)}
      <div class="actions"><button class="button primary" data-action="key-done">Done</button></div>
    </div>`;
};

ACTIONS['key-done'] = () => go({ view: 'machine', id: state.ui.shownKey ? state.ui.shownKey.id : '' });
