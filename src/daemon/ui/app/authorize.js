// Sign-in approval: is this you, what can it use, connected. Reached from the link
// `agentio login` prints, or from Review on the waiting sign-in banner.

const ENDED = 'This sign-in request has ended or was already answered. Run agentio login again on the machine.';

/** state.ui.auth = { code, step: 'loading' | 1 | 2 | 'done' | 'denied' | 'error', request?, key?, error? } */
function authState(code) {
  if (!state.ui.auth || state.ui.auth.code !== code) {
    state.ui.auth = { code, step: 'loading' };
    loadRequest(code);
  }
  return state.ui.auth;
}

async function loadRequest(code) {
  const res = await api(`/ui/api/authorize/${encodeURIComponent(code)}`);
  if (res.lost) return;
  const auth = state.ui.auth;
  if (!auth || auth.code !== code) return;
  if (res.ok) Object.assign(auth, { step: 1, request: res.body });
  else Object.assign(auth, { step: 'error', error: res.status === 404 ? ENDED : res.error });
  render();
}

VIEWS.authorize = (route) => {
  const auth = authState(route.code);
  const now = Date.now();
  const steps = (n) => html`<span class="steps">${n} / 3</span>`;

  if (auth.step === 'loading') return html`<div class="narrow"><h1>Sign-in request</h1><p class="muted">Loading…</p></div>`;
  if (auth.step === 'error') return html`<div class="narrow"><h1>Sign-in request</h1><div class="box alert">${auth.error}</div><p class="mt-12"><a class="btn" href="#profiles">Back to profiles</a></p></div>`;
  if (auth.step === 'denied') return html`<div class="narrow"><h1>Denied</h1><p>The terminal is told no. Nothing was created.</p><a class="btn" href="#profiles">Back to profiles</a></div>`;

  const req = auth.request;
  if (auth.step === 1) {
    return html`<div class="narrow">
      <div class="row"><h1 class="grow">Is this you?</h1>${steps(1)}</div>
      <p class="muted">A machine asked for access ${relativeTime(req.createdAt, now)}.</p>
      <div class="sketch my-16"><div class="code">${req.userCode}</div><div class="muted center">Is this the code in your terminal?</div></div>
      <div class="box"><span class="muted">The machine calls itself</span><br><b>${req.name}</b><div class="muted">This request ${timeLeft(req.expiresAt, now)}</div></div>
      <div class="col mt-22">
        <button class="btn pri block" data-action="auth-yes">Yes, it's mine</button>
        <button class="btn block" data-action="auth-deny">No, deny it</button>
      </div></div>`;
  }

  if (auth.step === 2) {
    return html`<div class="narrow">
      <div class="row"><h1 class="grow">What can ${req.name} use?</h1>${steps(2)}</div>
      <form data-submit="auth-approve">
        ${accessChooser('auth')}
        <div class="col mt-18">
          <button class="btn pri block">Give access</button>
          <button type="button" class="btn link" data-action="auth-deny">Deny instead</button>
        </div>
      </form></div>`;
  }

  const key = auth.key;
  const refs = reachableRefs(key, allRefs());
  const services = [...new Set(refs.map((r) => r.slice(0, r.indexOf('/'))))].sort();
  return html`<div class="narrow">
    <div class="row"><h1 class="grow">${key.name} is connected</h1>${steps(3)}</div>
    <p class="muted">Its terminal has the key. Nothing to copy.</p>
    <div class="box mt-14"><b>It can ${key.readOnly ? 'read' : 'use'}</b>
      <div class="icons">${services.map((svc) => icon(svc))}</div>
      <div class="muted">${plural(refs.length, 'profile')} · ${key.readOnly ? 'read-only' : 'read and write'}</div></div>
    <div class="col mt-18"><a class="btn block" href="${routeHash({ view: 'machine', id: key.id })}">See ${key.name}</a></div></div>`;
};

ACTIONS['auth-yes'] = () => { state.ui.auth.step = 2; render(); };

ACTIONS['auth-deny'] = async () => {
  const auth = state.ui.auth;
  const res = await api(`/ui/api/authorize/${encodeURIComponent(auth.code)}`, { method: 'POST', body: JSON.stringify({ approve: false }) });
  if (res.lost) return;
  if (res.ok) auth.step = 'denied';
  else Object.assign(auth, { step: 'error', error: res.status === 404 ? ENDED : res.error });
  await loadPending();
  render();
};

SUBMITS['auth-approve'] = async (form) => {
  const auth = state.ui.auth;
  let input;
  try {
    input = presetInput(readAccessChoice(form, 'auth'), auth.request.name);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const res = await api(`/ui/api/authorize/${encodeURIComponent(auth.code)}`, {
    method: 'POST',
    body: JSON.stringify({ approve: true, ...input, url: location.origin }),
  });
  if (res.lost) return;
  if (!res.ok) {
    Object.assign(auth, { step: 'error', error: res.status === 404 ? ENDED : res.error });
    render();
    return;
  }
  auth.key = res.body.key;
  auth.step = 'done';
  state.keys = [...state.keys, res.body.key];
  await loadPending();
  render();
};
