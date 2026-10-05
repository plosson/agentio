// Machines: every key, presented as the machine that holds it.

/** One machine as a list row: name, what it can use, when it was last seen. Also used by the Overview and Access. */
function machineItem(k, now, current = false) {
  return listItem({
    href: routeHash({ view: 'machine', id: k.id }),
    current,
    dot: seenToday(k, now),
    title: k.name,
    message: `Can use ${machineCanUse(k, allRefs())}${k.readOnly ? ' · read-only' : ''}`,
    meta: html`${statusMarkup(machineSeen(k, now))}<span>created ${shortDate(Date.parse(k.createdAt), now)}</span>`,
  });
}

/** The list pane: every machine by name, with Access and Connect in its toolbar. */
LISTS.machines = (route) => {
  const now = Date.now();
  const keys = [...state.keys].sort((a, b) => a.name.localeCompare(b.name));
  const current = route.view === 'machine' ? route.id : '';
  const actions = html`<div class="tools">
    <a class="icon-button" href="#access" title="Who can use what" aria-label="Access">${glyph('grid')}</a>
    <a class="icon-button" href="#connect" title="Connect a machine" aria-label="Connect a machine">${glyph('add')}</a></div>`;
  return html`${pageHead({ title: 'Machines', actions })}
    ${keys.length === 0
      ? html`<div class="empty-state"><p>No machines yet. On the machine, after installing agentio, run this and approve the code it shows:</p>${command(loginCommand(location.origin))}</div>`
      : html`<ul class="rows">${keys.map((k) => machineItem(k, now, k.id === current))}</ul>`}`;
};

/** Nothing chosen yet: the list is beside this (or, on a narrow window, instead of it). */
VIEWS.machines = () => html`
  ${pageHead({ title: 'Machines', count: state.keys.length })}
  ${emptyState(state.keys.length ? 'Choose a machine in the list to see it here.' : 'Connect a machine so an agent can use the vault.',
    html`<a class="button primary" href="#connect">Connect a machine</a>`)}`;

VIEWS.machine = (route) => {
  const revoked = state.ui.revoked && state.ui.revoked.id === route.id ? state.ui.revoked : null;
  if (revoked) return revokedView(revoked);
  const k = keyById(route.id);
  if (!k) return systemPage({ title: 'Not found', why: 'This machine was revoked or renamed.', action: html`<a class="button" href="#machines">Back to machines</a>` });
  const now = Date.now();
  const refs = reachableRefs(k, allRefs());
  const editing = state.ui.editScope === k.id;
  const names = serviceNames(refs.map((ref) => ({ service: ref.slice(0, ref.indexOf('/')) })), displayName);
  const value = k.allowedProfiles === '*' ? 'All profiles' : names.length ? listSummary(names) : 'No profiles';
  const seen = machineSeen(k, now);

  return html`
    ${pageHead({ path: [{ href: '#machines', label: 'Machines' }], title: k.name, rename: { key: `machine:${k.id}`, submit: 'rename-machine' } })}
    <div class="columns">
      <section>
        ${displayPanel('Can use', value, `${k.readOnly ? 'Read-only' : 'Read and write'} · ${seen.word.toLowerCase()}`)}
        <h2>Profiles ${editing ? '' : html`<button class="button link" data-action="edit-scope" data-id="${k.id}">Change</button>`}</h2>
        ${editing
          ? html`<form data-submit="save-scope" data-id="${k.id}">${profileChooser('scope', k.allowedProfiles)}
              <div class="actions"><button type="button" class="button" data-action="cancel-scope">Cancel</button><button class="button primary">Save</button></div></form>`
          : refs.length
            ? html`<ul class="list">${refs.map((ref) => {
                const r = rowByRef(ref);
                return listItem({
                  href: routeHash({ view: 'profile', ref }),
                  title: html`<span class="svc">${icon(r.service)}<span>${displayName(r.service)} / ${r.profile}</span></span>`,
                  meta: html`${statusText(effectiveStatus(r, state.results).status, r.service)}<span>${accessLevel(k, r).level}</span>`,
                });
              })}</ul>
              ${k.allowedProfiles === '*' ? html`<p class="note">All profiles, including ones added later.</p>` : ''}`
            : emptyState('It can use no profile. Change that above, or revoke it.')}
      </section>
      <section>
        <h2>Settings</h2>
        <div class="list">
          <label class="setting"><span class="text">Read-only on every profile</span>
            <span class="switch"><input type="checkbox" data-change="machine-ro" data-id="${k.id}" ${k.readOnly ? raw('checked') : ''}><span></span></span></label>
          <label class="setting"><span class="text">Can add and delete profiles</span>
            <span class="switch"><input type="checkbox" data-change="machine-manage" data-id="${k.id}" ${k.canManageProfiles ? raw('checked') : ''}><span></span></span></label>
        </div>
        <p class="note">${k.hint ? html`Key <span class="mono">…${k.hint}</span> · ` : ''}created ${shortDate(Date.parse(k.createdAt), now)}</p>
        <h2>Danger zone</h2>
        <div class="actions">
          <button class="button" data-action="replace-key" data-id="${k.id}">Replace key…</button>
          <button class="button danger" data-action="revoke-machine" data-id="${k.id}">Revoke…</button>
        </div>
      </section>
    </div>`;
};

/** After a revoke: the credentials it already fetched still work until reauthorised. */
function revokedView(revoked) {
  return html`
    ${pageHead({ path: [{ href: '#machines', label: 'Machines' }], title: `${revoked.name} is revoked` })}
    <div class="readable">
      <p>It can no longer get credentials from this hub. But it already received the credentials of the profiles it could read. Reauthorise them on the hub to make those copies useless.</p>
      ${revoked.refs.length
        ? revoked.refs.map((ref) => {
            const i = ref.indexOf('/');
            const service = ref.slice(0, i);
            return command(fixCommand(service, ref.slice(i + 1), Boolean(PLUGIN_METADATA[service]?.reauth)));
          })
        : html`<p class="muted">It could not read any profile.</p>`}
      <div class="actions"><a class="button" href="#machines">Back to machines</a></div>
    </div>`;
}

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

SUBMITS['rename-machine'] = async (form) => {
  const id = form.dataset.key.slice('machine:'.length);
  const k = keyById(id);
  const name = form.elements.name.value.trim();
  if (!k || name === k.name) { ACTIONS['cancel-rename'](); return; }
  state.ui.renameDraft = name;
  if (!name) { state.ui.renameError = 'Give the machine a name.'; render(); return; }
  const res = await api(`/ui/api/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  if (res.lost) return;
  if (!res.ok) { state.ui.renameError = res.error; render(); return; }
  storeKey(res.body);
  state.ui.renaming = null;
  state.ui.renameError = '';
  state.ui.renameDraft = undefined;
  toast(`Renamed to ${name}`);
  render();
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
  showKey(res.body.key, res.body.token, 'replaced');
};

ACTIONS['revoke-machine'] = async (el) => {
  const k = keyById(el.dataset.id);
  if (!k) return;
  const refs = reachableRefs(k, allRefs());
  const ok = await confirmDialog({
    title: `Revoke ${k.name}?`,
    body: `${k.name} loses access to ${plural(refs.length, 'profile')} now, and its key is deleted. This can't be undone.`,
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
