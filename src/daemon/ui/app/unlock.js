// The locked screen. Shown at boot when there is no session or the vault is locked,
// and by api() whenever the daemon answers 401 or 503. The hash is kept, so an
// approval link opened while locked lands on the sign-in after unlocking.

/**
 * `locked` tells apart a locked vault (no agent can get credentials) from a
 * browser that simply has no session (after Sign out, 30 idle minutes, or a
 * new browser) while the vault stays unlocked for every agent already using it.
 */
/** True when the owner asked their system for less motion: every animation below is skipped. */
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 0 : ms));

/**
 * A hand-drawn padlock. It draws itself in, floats, blinks its keyhole as the
 * owner types, rattles while the hub checks, shakes its head at a wrong
 * passphrase and swings open on the right one (see `.lock` in styles.css).
 */
function lockArt() {
  const body = 'M30 55 Q60 52 90 55 Q97 56 96 63 L95 97 Q95 104 88 104 L32 105 Q24 104 25 97 L24 62 Q24 55 30 55 Z';
  return raw(`<svg class="lock intro" id="lock" viewBox="0 0 120 120" aria-hidden="true">
    <path class="shackle" pathLength="1" d="M39 55 V39 a21 21 0 0 1 42 0 V55"/>
    <path class="body" pathLength="1" d="${body}"/>
    <path class="pencil" pathLength="1" d="${body}" transform="translate(1.5 1.2)"/>
    <g class="keyhole"><circle cx="60" cy="74" r="6.5"/><path d="M57 78 L55 91 L65 91 L63 78 Z"/></g>
    <g class="sparks"><path d="M98 30 l9 -7"/><path d="M101 44 l11 0"/><path d="M90 20 l4 -10"/></g>
  </svg>`);
}

/** Restarts a one-shot animation on the padlock. */
function lockMood(mood) {
  const lock = $('lock');
  if (!lock) return;
  lock.classList.remove('intro', 'busy', 'nope', 'open', 'peek');
  void lock.getBoundingClientRect(); // so the same mood can play twice in a row
  if (mood) lock.classList.add(mood);
}

function showUnlock(locked) {
  // An authorize request mid-`loadRequest` can lose its session before the request
  // loads; clear a still-loading one here so it is fetched again once signed back in.
  if (state.ui.auth && state.ui.auth.step === 'loading') state.ui.auth = null;
  state.loaded = false;
  $('bar').hidden = true;
  $('version').hidden = true;
  main.innerHTML = html`
    <div class="welcome">
      ${lockArt()}
      <h1>${locked ? 'The hub is locked' : 'Welcome back'}</h1>
      <p class="muted">${locked
        ? 'Your agents are waiting for their keys. Unlock the hub to hand them out again.'
        : 'The hub is open and your agents keep working. Sign in to manage it.'}</p>
      <form data-submit="unlock">
        <label class="field">Passphrase<input type="password" id="passphrase" data-input="unlock-type" autocomplete="current-password" required></label>
        <div id="unlock-error" class="box alert" role="alert" hidden></div>
        <button class="btn pri block mt-12" id="unlock-btn">${locked ? 'Unlock' : 'Sign in'}</button>
      </form>
    </div>`.__html;
  setTitle();
  $('passphrase').focus();
}

INPUTS['unlock-type'] = () => lockMood('peek');

SUBMITS.unlock = async (form) => {
  const err = $('unlock-error');
  const button = $('unlock-btn');
  const label = button.textContent;
  err.hidden = true;
  button.disabled = true;
  button.textContent = 'Checking…';
  lockMood('busy');
  let opened = false;
  try {
    const res = await api('/ui/api/unlock', { method: 'POST', body: JSON.stringify({ passphrase: $('passphrase').value }) });
    if (!res.ok) {
      lockMood('nope');
      err.textContent = res.status === 401 ? 'Wrong passphrase. Try again.' : res.error;
      err.hidden = false;
      $('passphrase').select();
      return;
    }
    const probe = await api('/ui/api/session');
    if (!probe.ok || !probe.body.authenticated) {
      lockMood('nope');
      err.textContent = 'Unlocked, but the browser did not keep the session cookie. Open the admin at http://127.0.0.1:7890/ui or over HTTPS.';
      err.hidden = false;
      return;
    }
    opened = true;
    button.textContent = 'Opening…';
    lockMood('open');
    await pause(700);
    await openHub();
  } finally {
    if (!opened && $('unlock-btn')) {
      $('unlock-btn').disabled = false;
      $('unlock-btn').textContent = label;
    }
  }
};

async function openHub() {
  if (await loadAll()) render();
}
