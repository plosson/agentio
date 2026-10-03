// Settings: this hub, the browser session, and locking the vault.

VIEWS.settings = () => html`
  ${pageHead({ title: 'Settings' })}
  <div class="readable">
    <h2>About</h2>
    <ul class="list">
      ${listItem({ title: 'Address', message: html`<span class="mono">${location.origin}</span>` })}
      ${listItem({ title: 'Version', message: html`<span class="mono">${state.version ? 'v' + state.version : 'unknown'}</span>` })}
    </ul>
    <h2>Browser session</h2>
    <p>Ends after 30 idle minutes. Signing out leaves the vault unlocked.</p>
    <div class="actions"><button class="button" data-action="sign-out">Sign out</button></div>
    <h2>Danger zone</h2>
    <p><b>Lock the vault.</b> Every agent fails until someone unlocks it here with the passphrase.</p>
    <div class="actions"><button class="button danger" data-action="lock">Lock the vault…</button></div>
  </div>`;

ACTIONS['sign-out'] = async () => {
  await api('/ui/api/logout', { method: 'POST' });
  leaveHub(false);
};

ACTIONS.lock = async () => {
  const ok = await confirmDialog({
    title: 'Lock the vault?',
    body: `Every agent using this hub stops getting credentials until someone unlocks it here. That is ${plural(state.keys.length, 'machine')}. Scheduled jobs on them fail meanwhile.`,
    action: 'Lock the vault',
  });
  if (!ok) return;
  await api('/ui/api/lock', { method: 'POST' });
  toast('Vault locked');
  leaveHub(true);
};
