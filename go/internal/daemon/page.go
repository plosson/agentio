package daemon

// uiPage is a small admin surface: unlock, profiles, device approval, keys.
// The nonce and plugin metadata are substituted per response.
const uiPage = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agentio</title>
<style nonce="__CSP_NONCE__">
  body { font: 15px/1.4 ui-sans-serif, system-ui, sans-serif; margin: 2rem; max-width: 42rem; }
  section { margin: 1.5rem 0; }
  label { display: block; margin: 0.4rem 0; }
  input, button { font: inherit; }
  pre { white-space: pre-wrap; }
  .err { color: #8a1f1f; }
</style>
</head>
<body>
<h1>agentio</h1>
<p id="session">…</p>
<section id="unlock">
  <h2>Unlock</h2>
  <form id="unlock-form">
    <label>Passphrase <input id="pass" type="password" autocomplete="current-password"></label>
    <button type="submit">Unlock</button>
  </form>
</section>
<section>
  <h2>Profiles</h2>
  <pre id="profiles"></pre>
</section>
<section>
  <h2>Approve a login</h2>
  <form id="auth-form">
    <label>User code <input id="code" autocomplete="off"></label>
    <label>Key name <input id="kname" value="agent"></label>
    <label>Hub URL <input id="hub" value="http://127.0.0.1:7890"></label>
    <label><input id="star" type="checkbox" checked> All profiles</label>
    <label><input id="manage" type="checkbox"> Can manage profiles</label>
    <button type="submit" name="approve" value="yes">Approve</button>
    <button type="submit" name="approve" value="no">Deny</button>
  </form>
</section>
<section>
  <h2>Keys</h2>
  <pre id="keys"></pre>
  <button id="lock" type="button">Lock</button>
  <button id="logout" type="button">Log out</button>
</section>
<script nonce="__CSP_NONCE__">
const meta = __PLUGIN_METADATA__;
const out = (id, value) => { document.getElementById(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { error: text }; }
  if (!res.ok) throw new Error((body && body.error) || res.statusText);
  return body;
}
async function refresh() {
  const session = await api('/ui/api/session');
  out('session', session.authenticated ? (session.locked ? 'Signed in, vault locked' : 'Signed in') : 'Signed out');
  if (!session.authenticated || session.locked) { out('profiles', ''); out('keys', ''); return; }
  out('profiles', await api('/ui/api/profiles'));
  out('keys', await api('/ui/api/keys'));
}
document.getElementById('unlock-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('/ui/api/unlock', { method: 'POST', body: JSON.stringify({ passphrase: document.getElementById('pass').value }) });
    await refresh();
  } catch (err) { out('session', err.message); }
});
document.getElementById('auth-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const approve = ev.submitter && ev.submitter.value === 'yes';
  const code = document.getElementById('code').value;
  const body = {
    approve,
    name: document.getElementById('kname').value,
    url: document.getElementById('hub').value,
    allowedProfiles: document.getElementById('star').checked ? '*' : [],
    readOnly: false,
    canManageProfiles: document.getElementById('manage').checked
  };
  try {
    await api('/ui/api/authorize/' + encodeURIComponent(code), { method: 'POST', body: JSON.stringify(body) });
    await refresh();
  } catch (err) { out('keys', err.message); }
});
document.getElementById('lock').addEventListener('click', async () => { await api('/ui/api/lock', { method: 'POST' }); await refresh(); });
document.getElementById('logout').addEventListener('click', async () => { await api('/ui/api/logout', { method: 'POST' }); await refresh(); });
refresh().catch((err) => out('session', err.message));
void meta;
</script>
</body>
</html>
`
