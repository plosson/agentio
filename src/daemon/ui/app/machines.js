// Machines: every key, presented as the machine that holds it.

VIEWS.machines = () => {
  const now = Date.now();
  const keys = [...state.keys].sort((a, b) => a.name.localeCompare(b.name));
  const refs = allRefs();
  const connect = state.ui.connectOpen ? html`
    <div class="box mt-14">
      <h2 class="mt-0">Connect a machine</h2>
      <p>On the machine, after installing agentio, run this and approve the code it shows. Nothing to copy back.</p>
      <div class="codebox"><code>${loginCommand(location.origin)}</code>${copyButton(loginCommand(location.origin))}</div>
      <details class="mt-8"><summary>Or create a key by hand, to paste on the machine</summary>
        <form class="mt-10" data-submit="create-key">
          <label class="field">Name<input type="text" name="name" placeholder="e.g. laptop, ci, build-box" required maxlength="64" autocomplete="off"></label>
          ${accessChooser('create')}
          <div class="row end"><button type="button" class="btn" data-action="toggle-connect">Cancel</button><button class="btn pri">Create key</button></div>
        </form></details>
    </div>` : '';

  return html`
    <div class="row"><div class="grow"><h1>Machines</h1><span class="muted">Each machine has its own key to this hub.</span></div>
      <button class="btn pri" data-action="toggle-connect">Connect a machine</button></div>
    ${connect}
    ${keys.length === 0
      ? html`<div class="box empty mt-14"><h2>No machines yet.</h2><p class="muted">Connect one with <code>${loginCommand(location.origin)}</code>.</p></div>`
      : html`<div class="box mt-14"><table class="stack">
          <tr><th>Machine</th><th>Can use</th><th>Access</th><th>Last seen</th></tr>
          ${keys.map((k) => html`<tr>
            <td><a href="${routeHash({ view: 'machine', id: k.id })}"><b>${k.name}</b></a><div class="muted">created ${shortDate(Date.parse(k.createdAt), now)}</div></td>
            <td>${machineCanUse(k, refs)}</td>
            <td>${k.readOnly ? html`<span class="pill ro">read-only</span>` : 'read and write'}</td>
            <td>${isSilent(k, now) ? html`<span class="pill warn" title="Silent for over ${SILENT_DAYS} days">${relativeTime(k.lastUsedAt, now)}</span>` : relativeTime(k.lastUsedAt, now)}</td>
          </tr>`)}
        </table></div>`}`;
};

VIEWS.machine = (route) => {
  const revoked = state.ui.revoked && state.ui.revoked.id === route.id ? state.ui.revoked : null;
  if (revoked) return revokedView(revoked);
  const k = keyById(route.id);
  if (!k) return html`<a class="muted" href="#machines">Machines ›</a><h1>Machine not found</h1><p>It may have been revoked.</p><a class="btn" href="#machines">Back to machines</a>`;
  const now = Date.now();
  const refs = reachableRefs(k, allRefs());
  const editing = state.ui.editScope === k.id;

  return html`
    <a class="muted" href="#machines">Machines ›</a>
    <div class="row"><div class="grow"><h1>${k.name}</h1>
      <span class="muted">Created ${shortDate(Date.parse(k.createdAt), now)} · last seen ${relativeTime(k.lastUsedAt, now)}${k.hint ? html` · key …${k.hint}` : ''}</span></div>
      <button class="btn" data-action="rename-machine" data-id="${k.id}">Rename</button></div>
    <div class="grid2 mt-12">
      <div>
        <div class="section-title">Can use ${editing ? '' : html`<button class="btn link" data-action="edit-scope" data-id="${k.id}">Change</button>`}</div>
        ${editing
          ? html`<form class="box" data-submit="save-scope" data-id="${k.id}">${profileChooser('scope', k.allowedProfiles)}
              <div class="row end"><button type="button" class="btn" data-action="cancel-scope">Cancel</button><button class="btn pri">Save</button></div></form>`
          : html`<div class="box">${refs.length
              ? html`<table>${refs.map((ref) => {
                  const r = rowByRef(ref);
                  return html`<tr><td><a href="${routeHash({ view: 'profile', ref })}">${profileLabel(r)}</a></td><td>${statusText(effectiveStatus(r, state.results).status, r.service)}</td></tr>`;
                })}</table>`
              : html`<span class="muted">No profiles.</span>`}
              ${k.allowedProfiles === '*' ? html`<div class="muted mt-6">All profiles, including ones added later.</div>` : ''}</div>`}
      </div>
      <div class="col">
        <div class="section-title">Settings</div>
        <div class="box">
          <div class="row"><span class="grow">Read-only on every profile</span><label class="tog"><input type="checkbox" data-change="machine-ro" data-id="${k.id}" ${k.readOnly ? raw('checked') : ''} aria-label="Read-only on every profile"><span></span></label></div>
          <div class="row mt-8"><span class="grow">Can add and delete profiles</span><label class="tog"><input type="checkbox" data-change="machine-manage" data-id="${k.id}" ${k.canManageProfiles ? raw('checked') : ''} aria-label="Can add and delete profiles"><span></span></label></div>
        </div>
        <div class="box"><div class="muted">Lost the key file?</div><button class="btn" data-action="replace-key" data-id="${k.id}">Replace key</button></div>
        <div class="box alert"><b>Revoke access</b><div class="muted">${k.name} loses ${refs.length === 1 ? 'its profile' : `its ${plural(refs.length, 'profile')}`} now.</div>
          <button class="btn red mt-6" data-action="revoke-machine" data-id="${k.id}">Revoke…</button></div>
      </div>
    </div>`;
};

/** After a revoke: the credentials it already fetched still work until reauthorised. */
function revokedView(revoked) {
  return html`
    <a class="muted" href="#machines">Machines ›</a>
    <h1>${revoked.name} is revoked</h1>
    <p>It can no longer fetch credentials from this hub. But it already received the credentials of the profiles it could read; reauthorise them on the hub to make those copies useless.</p>
    ${revoked.refs.length
      ? html`<div class="box">${revoked.refs.map((ref) => {
          const i = ref.indexOf('/');
          const service = ref.slice(0, i);
          const command = fixCommand(service, ref.slice(i + 1), Boolean(PLUGIN_METADATA[service]?.reauth));
          return html`<div class="codebox"><code>${command}</code>${copyButton(command)}</div>`;
        })}</div>`
      : html`<p class="muted">It could not read any profile.</p>`}
    <a class="btn" href="#machines">Back to machines</a>`;
}

ACTIONS['toggle-connect'] = () => { state.ui.connectOpen = !state.ui.connectOpen; render(); };
ACTIONS['edit-scope'] = (el) => { state.ui.editScope = el.dataset.id; render(); };
ACTIONS['cancel-scope'] = () => { state.ui.editScope = null; render(); };

/** Replaces a key in `state.keys` with the daemon's answer. */
function storeKey(key) {
  state.keys = state.keys.map((k) => (k.id === key.id ? key : k));
}

async function patchKey(id, body) {
  const res = await api(`/ui/api/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  if (res.lost) return null;
  if (!res.ok) { toast(res.error, 'error'); return null; }
  storeKey(res.body);
  return res.body;
}

SUBMITS['create-key'] = async (form) => {
  const name = form.elements.name.value.trim();
  let input;
  try {
    input = presetInput(readAccessChoice(form, 'create'), name);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const res = await api('/ui/api/keys', { method: 'POST', body: JSON.stringify({ ...input, url: location.origin }) });
  if (res.lost) return;
  if (!res.ok) { toast(res.error, 'error'); return; }
  state.keys = [...state.keys, res.body.key];
  state.ui.connectOpen = false;
  render();
  showToken(res.body.token);
};

SUBMITS['save-scope'] = async (form) => {
  const allowedProfiles = readProfileChoice(form, 'scope');
  if (Array.isArray(allowedProfiles) && allowedProfiles.length === 0) {
    toast('A machine needs at least one profile. To cut it off, revoke it.', 'error');
    return;
  }
  if (await patchKey(form.dataset.id, { allowedProfiles })) {
    state.ui.editScope = null;
    toast('Saved');
    render();
  }
};

CHANGES['machine-ro'] = async (input) => {
  const key = await patchKey(input.dataset.id, { readOnly: input.checked });
  if (!key) { input.checked = !input.checked; return; }
  toast(input.checked ? `${key.name} is now read-only` : `${key.name} can write again`);
  render();
};

CHANGES['machine-manage'] = async (input) => {
  const key = await patchKey(input.dataset.id, { canManageProfiles: input.checked });
  if (!key) { input.checked = !input.checked; return; }
  toast(input.checked ? `${key.name} can add and delete profiles` : `${key.name} can no longer add or delete profiles`);
  render();
};

ACTIONS['rename-machine'] = async (el) => {
  const k = keyById(el.dataset.id);
  if (!k) return;
  const name = await renameDialog(k.name, k.name);
  if (!name) return;
  if (await patchKey(k.id, { name })) { toast(`Renamed to ${name}`); render(); }
};

ACTIONS['replace-key'] = async (el) => {
  const k = keyById(el.dataset.id);
  if (!k) return;
  const ok = await confirmDialog({
    title: `Replace the key of ${k.name}?`,
    body: 'A new key is issued and the current one stops working at once. The machine fails until you install the new key on it.',
    action: 'Replace key',
  });
  if (!ok) return;
  const res = await api(`/ui/api/keys/${encodeURIComponent(k.id)}/rotate`, { method: 'POST', body: JSON.stringify({ url: location.origin }) });
  if (res.lost) return;
  if (!res.ok) { toast(res.error, 'error'); return; }
  storeKey(res.body.key);
  render();
  showToken(res.body.token);
};

ACTIONS['revoke-machine'] = async (el) => {
  const k = keyById(el.dataset.id);
  if (!k) return;
  const refs = reachableRefs(k, allRefs());
  const ok = await confirmDialog({
    title: `Revoke ${k.name}?`,
    body: `${k.name} loses access to ${plural(refs.length, 'profile')} now, and its key is deleted. This cannot be undone.`,
    action: 'Revoke access',
  });
  if (!ok) return;
  const res = await api(`/ui/api/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
  if (res.lost) return;
  if (!res.ok) { toast(res.error, 'error'); return; }
  state.keys = state.keys.filter((x) => x.id !== k.id);
  state.ui.revoked = { id: k.id, name: k.name, refs };
  render();
};
