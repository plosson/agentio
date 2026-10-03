// The gate: unlock the vault, or sign this browser in. Shown at boot when there is no
// session or the vault is locked, and by api() whenever the daemon answers 401 or 503.
// Before the admin has loaded it fills the page. After that it opens as a dialog over
// the screen, so a session that ends mid-task loses nothing the owner typed. The hash is
// kept, so an approval link opened while locked lands on the approval after unlocking.

/** True when the owner asked their system for less motion: every animation below is skipped. */
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 0 : ms));

/** The vault icon, inline so its dial can turn (see `.vault` in admin.css). */
const vaultArt = () => raw(VAULT_ICON.replace('<svg ', '<svg class="vault" id="vault" aria-hidden="true" '));

/** Plays one state change on the vault: checking (dial turns), nope (one shake), open (quarter turn). */
function vaultMood(mood) {
  const art = $('vault');
  if (!art) return;
  art.classList.remove('checking', 'nope', 'open');
  void art.getBoundingClientRect(); // so the same mood can play twice in a row
  if (mood) art.classList.add(mood);
}

/**
 * `locked` tells apart a locked vault (no agent can get credentials) from a browser
 * that simply has no session (after Sign out, 30 idle minutes, or a new browser)
 * while the vault stays unlocked for every agent already using it.
 */
function gateMarkup(locked) {
  return html`<div class="gate">
    <div class="stacked">${vaultArt()}<span>agentio</span></div>
    <h1 id="gate-title">${locked ? 'Unlock the vault' : 'Sign in to continue'}</h1>
    <p class="lede">${locked ? "Your agents can't get their keys until you unlock it." : 'The vault is unlocked and your agents keep working.'}</p>
    <form data-submit="unlock" novalidate>
      <label class="form-field"><span class="label">Passphrase</span>
        <input class="input" type="password" id="passphrase" autocomplete="current-password" aria-describedby="unlock-error"></label>
      <span id="unlock-error" class="field-error" role="alert" hidden></span>
      <button class="button strong wide" id="unlock-btn">${locked ? 'Unlock' : 'Sign in'}</button>
      <p class="help center">Forgot the passphrase? It can't be recovered.</p>
    </form></div>`;
}

function showUnlock(locked) {
  closeMenu();
  // An authorize request mid-`loadRequest` can lose its session before the request
  // loads; clear a still-loading one here so it is fetched again once signed back in.
  if (state.ui.auth && state.ui.auth.step === 'loading') state.ui.auth = null;
  if (state.loaded) {
    // Mid-task: keep the screen and everything typed on it, and ask over it.
    const dialog = $('gate-dialog');
    if (dialog.open && dialog.dataset.locked === String(locked)) return; // already asking; keep what is typed
    const typed = dialog.open && $('passphrase') ? $('passphrase').value : '';
    dialog.dataset.locked = String(locked);
    dialog.innerHTML = gateMarkup(locked).__html;
    $('passphrase').value = typed; // the mode flipped while open: keep what was typed
    if (!dialog.open) dialog.showModal();
    $('passphrase').focus();
    return;
  }
  $('bar').hidden = true;
  $('version').hidden = true;
  main.innerHTML = gateMarkup(locked).__html;
  setTitle();
  $('passphrase').focus();
}

/** Sign out or lock on purpose: forget the screen and show the full-page gate. */
function leaveHub(locked) {
  state.loaded = false;
  const dialog = $('gate-dialog');
  if (dialog.open) dialog.close();
  dialog.textContent = '';
  showUnlock(locked);
}

function showGateError(message) {
  const err = $('unlock-error');
  const input = $('passphrase');
  err.textContent = `✗ ${message}`;
  err.hidden = false;
  input.setAttribute('aria-invalid', 'true');
  input.focus();
  input.select();
}

SUBMITS.unlock = async () => {
  const button = $('unlock-btn');
  const input = $('passphrase');
  const label = button.textContent;
  $('unlock-error').hidden = true;
  input.removeAttribute('aria-invalid');
  if (!input.value) { showGateError('Enter the passphrase.'); return; }
  button.disabled = true;
  button.textContent = 'Checking…';
  vaultMood('checking');
  let opened = false;
  try {
    const res = await api('/ui/api/unlock', { method: 'POST', body: JSON.stringify({ passphrase: input.value }) });
    if (!res.ok) {
      vaultMood('nope');
      showGateError(res.status === 401 ? 'Wrong passphrase. Try again.' : res.error);
      return;
    }
    const probe = await api('/ui/api/session');
    if (!probe.ok || !probe.body.authenticated) {
      vaultMood('nope');
      showGateError('Unlocked, but the browser did not keep the session cookie. Open the admin at http://127.0.0.1:7890/ui or over HTTPS.');
      return;
    }
    opened = true;
    button.textContent = 'Opening…';
    vaultMood('open');
    await pause(250);
    await openHub();
  } finally {
    if (!opened && $('unlock-btn')) {
      $('unlock-btn').disabled = false;
      $('unlock-btn').textContent = label;
    }
  }
};

async function openHub() {
  const dialog = $('gate-dialog');
  if (dialog.open) {
    dialog.close();
    dialog.textContent = '';
    // The screen and what was typed on it stay; only the data underneath refreshes.
    // An authorize screen that lost its request to the 401 must render to load it again.
    const stalled = currentRoute().view === 'authorize' && (!state.ui.auth || state.ui.auth.step === 'loading');
    if ((await loadAll()) && (!formOpen() || stalled)) render();
    return;
  }
  if (await loadAll()) render();
}
