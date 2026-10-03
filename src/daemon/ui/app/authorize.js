// Approve a sign-in on one screen: the code to compare, who asks and for how long, what it
// may use, then Approve or Deny. Reached from the link `agentio login` prints, or from
// Review on the waiting sign-in banner. Designed for the phone in the owner's hand.

const ENDED = 'This sign-in request has ended or was already answered. Run agentio login again on the machine.';

/** state.ui.auth = { code, step: 'loading' | 'ask' | 'done' | 'denied' | 'error', request?, key?, error?, ended? } */
function authState(code) {
  if (!state.ui.auth || state.ui.auth.code !== code) {
    state.ui.auth = { code, step: 'loading' };
    loadRequest(code);
  }
  return state.ui.auth;
}

/** The request could not be loaded or answered: a 404 means it ended or was already answered. */
function endAuth(auth, res) {
  Object.assign(auth, { step: 'error', ended: res.status === 404, error: res.status === 404 ? ENDED : res.error });
}

/** Approve and Deny are one-shot: busy blocks a second tap while the first answer is in flight. */
function setAuthBusy(auth, busy) {
  auth.busy = busy;
  document.querySelectorAll('[data-action="auth-deny"], form[data-submit="auth-approve"] button').forEach((el) => { el.disabled = busy; });
}

async function loadRequest(code) {
  const res = await api(`/ui/api/authorize/${encodeURIComponent(code)}`);
  if (res.lost) return;
  const auth = state.ui.auth;
  if (!auth || auth.code !== code) return;
  if (res.ok) Object.assign(auth, { step: 'ask', request: res.body });
  else endAuth(auth, res);
  render();
}

const toOverview = () => html`<a class="button" href="#overview">Go to the overview</a>`;

VIEWS.authorize = (route) => {
  const auth = authState(route.code);
  const now = Date.now();

  if (auth.step === 'loading') return html`<div class="narrow"><h1>Sign-in request</h1><p class="status neutral mt-8"><span aria-hidden="true">⟳</span> Loading…</p></div>`;
  if (auth.step === 'error') return systemPage({ title: auth.ended ? 'This request ended' : "Couldn't load the request", why: auth.error, action: toOverview() });
  if (auth.step === 'denied') return systemPage({ title: 'Denied', why: 'The terminal is told no. Nothing was created.', action: toOverview() });

  const req = auth.request;
  if (auth.step === 'ask') {
    return html`<div class="narrow">
      <h1>Approve this sign-in?</h1>
      <div class="mt-16">${displayPanel('Code', req.userCode)}</div>
      <p class="note">Is this the code in your terminal? If not, deny it.</p>
      <p class="mt-16"><b>${req.name}</b> asks · <span data-countdown="${req.expiresAt}">${countdown(req.expiresAt, now)}</span></p>
      <form data-submit="auth-approve">
        <h2>What it can use</h2>
        ${accessChooser('auth')}
        <div class="actions stack">
          <button type="button" class="button" data-action="auth-deny">Deny</button>
          <button class="button primary">Approve</button>
        </div>
      </form></div>`;
  }

  const key = auth.key;
  const refs = reachableRefs(key, allRefs());
  const names = serviceNames(refs.map((ref) => ({ service: ref.slice(0, ref.indexOf('/')) })), displayName);
  return html`<div class="narrow">
    <h1>${key.name} is connected</h1>
    <p class="muted mt-8">Its terminal has the key. Nothing to copy.</p>
    ${displayPanel('It can use', key.allowedProfiles === '*' ? 'All profiles' : listSummary(names), `${plural(refs.length, 'profile')} · ${key.readOnly ? 'read-only' : 'read and write'}`)}
    <div class="actions"><a class="button" href="${routeHash({ view: 'machine', id: key.id })}">See ${key.name}</a></div></div>`;
};

ACTIONS['auth-deny'] = async () => {
  const auth = state.ui.auth;
  if (auth.step !== 'ask' || auth.busy) return;
  setAuthBusy(auth, true);
  const res = await api(`/ui/api/authorize/${encodeURIComponent(auth.code)}`, { method: 'POST', body: JSON.stringify({ approve: false }) });
  setAuthBusy(auth, false);
  if (res.lost) return;
  if (auth.step === 'ask') {
    if (res.ok) auth.step = 'denied';
    else endAuth(auth, res);
  }
  await loadPending();
  render();
};

SUBMITS['auth-approve'] = async (form) => {
  const auth = state.ui.auth;
  if (auth.step !== 'ask' || auth.busy) return;
  let input;
  try {
    input = presetInput(readAccessChoice(form, 'auth'), auth.request.name);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  setAuthBusy(auth, true);
  const res = await api(`/ui/api/authorize/${encodeURIComponent(auth.code)}`, {
    method: 'POST',
    body: JSON.stringify({ approve: true, ...input, url: location.origin }),
  });
  setAuthBusy(auth, false);
  if (res.lost) return;
  if (!res.ok) {
    if (auth.step !== 'ask') return;
    endAuth(auth, res);
    render();
    return;
  }
  // A successful approval always lands on done, whatever the screen showed meanwhile.
  auth.key = res.body.key;
  auth.step = 'done';
  state.keys = [...state.keys, res.body.key];
  await loadPending();
  render();
};
