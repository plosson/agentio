// The locked screen. Shown at boot when there is no session or the vault is locked,
// and by api() whenever the daemon answers 401 or 503. The hash is kept, so an
// approval link opened while locked lands on the sign-in after unlocking.

/**
 * `locked` tells apart a locked vault (no agent can get credentials) from a
 * browser that simply has no session (after Sign out, 30 idle minutes, or a
 * new browser) while the vault stays unlocked for every agent already using it.
 */
function showUnlock(locked) {
  // An authorize request mid-`loadRequest` can lose its session before the request
  // loads; clear a still-loading one here so it is fetched again once signed back in.
  if (state.ui.auth && state.ui.auth.step === 'loading') state.ui.auth = null;
  state.loaded = false;
  $('bar').hidden = true;
  $('tabbar').hidden = true;
  main.innerHTML = html`
    <div class="narrow">
      <h1>${locked ? 'The hub is locked' : 'Sign in to the hub'}</h1>
      ${locked
        ? html`<div class="box alert my-12">Agents can't get any credentials until you unlock it.</div>`
        : html`<p class="muted">Enter the passphrase to manage this hub. Agents keep working meanwhile.</p>`}
      <form data-submit="unlock">
        <label class="field">Passphrase<input type="password" id="passphrase" autocomplete="current-password" required></label>
        <div id="unlock-error" class="box alert" hidden></div>
        <button class="btn pri block mt-12" id="unlock-btn">${locked ? 'Unlock' : 'Sign in'}</button>
      </form>
    </div>`.__html;
  $('passphrase').focus();
}

SUBMITS.unlock = async (form) => {
  const err = $('unlock-error');
  err.hidden = true;
  $('unlock-btn').disabled = true;
  try {
    const res = await api('/ui/api/unlock', { method: 'POST', body: JSON.stringify({ passphrase: $('passphrase').value }) });
    if (!res.ok) {
      err.textContent = res.status === 401 ? 'Wrong passphrase. Try again.' : res.error;
      err.hidden = false;
      return;
    }
    const probe = await api('/ui/api/session');
    if (!probe.ok || !probe.body.authenticated) {
      err.textContent = 'Unlocked, but the browser did not keep the session cookie. Open the admin at http://127.0.0.1:7890/ui or over HTTPS.';
      err.hidden = false;
      return;
    }
    await openHub();
  } finally {
    if ($('unlock-btn')) $('unlock-btn').disabled = false;
  }
};

async function openHub() {
  if (await loadAll()) render();
}
