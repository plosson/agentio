// Settings, behind the gear: the hub, the browser session, and locking.

VIEWS.settings = () => html`
  <h1>Settings</h1>
  <p class="muted">This hub, your browser session, and the vault.</p>
  <h2>Hub</h2>
  <div class="box">
    <div class="row"><span class="grow">Address</span><code>${location.origin}</code></div>
    <div class="row mt-6"><span class="grow">Version</span><code>${state.version ? 'v' + state.version : '—'}</code></div>
  </div>
  <h2>Browser session</h2>
  <div class="box row"><span class="grow">Ends after 30 idle minutes. Signing out leaves the vault unlocked.</span><button class="btn" data-action="sign-out">Sign out</button></div>
  <h2 class="text-red">Danger zone</h2>
  <div class="box alert row"><span class="grow"><b>Lock the vault</b><br><span class="muted">Every agent fails until someone unlocks it here with the passphrase.</span></span><button class="btn red" data-action="lock">Lock vault…</button></div>`;

ACTIONS['sign-out'] = async () => {
  await api('/ui/api/logout', { method: 'POST' });
  leaveHub(false);
};

ACTIONS.lock = async () => {
  const ok = await confirmDialog({
    title: 'Lock the vault?',
    body: `Every agent using this hub stops getting credentials until someone unlocks it here. That is ${plural(state.keys.length, 'machine')}. Scheduled jobs on them fail meanwhile.`,
    action: 'Lock vault',
  });
  if (!ok) return;
  await api('/ui/api/lock', { method: 'POST' });
  toast('Vault locked');
  leaveHub(true);
};
