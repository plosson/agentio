// Profiles: the list grouped by service, one profile with its fix, and adding one.

VIEWS.profiles = () => {
  const now = Date.now();
  const s = hubSummary(state.rows, state.keys, state.results, now);
  const broken = state.rows.filter((r) => effectiveStatus(r, state.results).status === 'invalid');
  const visible = filteredRows(state.rows);
  const groups = groupProfiles(visible, displayName);
  const subtitle = [plural(s.profiles, 'profile'), s.testedAt ? `tested at ${clockTime(s.testedAt)}` : 'not tested in this session', s.failing ? `${s.failing} not working` : ''].filter(Boolean).join(' · ');

  return html`
    <div class="row"><div class="grow"><h1>Profiles</h1><span class="muted">${subtitle}</span></div>
      <button class="btn" data-action="test-all" ${state.rows.length ? '' : raw('disabled')}>Test all</button>
      <a class="btn pri" href="#add">Add a profile</a></div>
    ${broken.map((r) => html`<div class="box alert row mt-12"><span class="grow">${profileLabel(r)} · ${effectiveStatus(r, state.results).detail || 'not working'}</span>
      <a class="btn pri" href="${routeHash({ view: 'profile', ref: refOf(r) })}">Fix</a></div>`)}
    ${state.rows.length ? filterBox(visible.length, state.rows.length) : ''}
    ${state.rows.length === 0
      ? html`<div class="box empty mt-12"><h2>No profiles yet.</h2><p class="muted">Profiles are added from a terminal on the hub.</p><a class="btn pri" href="#add">Add a profile</a></div>`
      : visible.length === 0 ? noMatch()
      : html`<div class="box mt-12"><table class="stack compact">
          <tr><th>Service</th><th>Profile</th><th>Status</th><th>Used by</th></tr>
          ${groups.map((g) => g.rows.map((r, i) => {
            const st = effectiveStatus(r, state.results);
            const users = machinesUsing(state.keys, r).length;
            // The service is named on its first profile only; a line separates services.
            return html`<tr class="${i === 0 ? 'starts' : 'same'}">
              <td class="service">${i === 0 ? html`<span class="svc">${icon(g.service)}${g.name}</span>` : ''}</td>
              <td><a href="${routeHash({ view: 'profile', ref: refOf(r) })}">${r.profile}</a>${r.readOnly ? html` <span class="pill ro">read-only</span>` : ''}</td>
              <td>${pill(st.status, r.service)}</td>
              <td><span class="phone-only">Used by </span>${plural(users, 'machine')}</td>
            </tr>`;
          }))}
        </table></div>`}`;
};

VIEWS.profile = (route) => {
  const r = rowByRef(route.ref);
  if (!r) return html`<a class="muted" href="#profiles">Profiles ›</a><h1>Profile not found</h1><p>It may have been renamed or deleted.</p><a class="btn" href="#profiles">Back to profiles</a>`;
  const now = Date.now();
  const st = effectiveStatus(r, state.results);
  const users = machinesUsing(state.keys, r);
  const testedText = st.at ? `tested ${relativeTime(st.at, now)}` : '';
  const ref = refOf(r);
  const fix = fixCommand(r.service, r.profile, Boolean(PLUGIN_METADATA[r.service]?.reauth));

  const statusBox = st.status === 'invalid'
    ? html`<div class="box alert"><b>The last test failed</b><div class="mono mt-4">${st.detail || 'No details were given.'}</div></div>
        <div class="box hl"><b>To fix it, run this on the hub</b>
          <div class="codebox"><code>${fix}</code>${copyButton(fix)}</div>
          <button class="btn pri" data-action="test-one" data-ref="${ref}">Test again</button></div>`
    : st.status === 'no-creds'
      ? html`<div class="box hl"><b>This profile has no credentials yet</b>
          <div class="codebox"><code>${fix}</code>${copyButton(fix)}</div>
          <button class="btn" data-action="test-one" data-ref="${ref}">Test</button></div>`
      : html`<div class="box row"><span class="grow">${st.status === 'skipped' ? 'Not tested in this session.' : st.status === 'testing' ? 'Testing…' : html`Working${st.detail ? html` · ${st.detail}` : ''}${testedText ? html` · ${testedText}` : ''}`}</span>
          <button class="btn" data-action="test-one" data-ref="${ref}" ${st.status === 'testing' ? raw('disabled') : ''}>Test</button></div>`;

  return html`
    <a class="muted" href="#profiles">Profiles ›</a>
    <div class="row"><span class="svc grow">${icon(r.service, 'lg')}<span><h1 class="m-0">${r.service} / ${r.profile}</h1>${r.info ? html`<span class="muted">${r.info}</span>` : ''}</span></span>${pill(st.status, r.service)}</div>
    <div class="grid2 mt-14">
      <div class="col">${statusBox}</div>
      <div class="col">
        <div class="box"><b>Used by</b>${users.length
          ? users.map((u) => html`<div><a href="${routeHash({ view: 'machine', id: u.key.id })}">${u.key.name}</a> · ${u.canWrite ? 'can write' : 'read-only'}</div>`)
          : html`<div class="muted">No machine can use it.</div>`}</div>
        ${r.readOnly
          ? html`<div class="box"><b>Read-only</b><div class="muted">Machines can read through it but never change anything. To allow writes, run this on the hub:</div>
              <div class="codebox"><code>${allowWritesCommand(r.service, r.profile)}</code>${copyButton(allowWritesCommand(r.service, r.profile))}</div>
              <div class="muted">If it was signed in with read-only permissions, sign in again instead.</div></div>`
          : html`<div class="box"><b>Can write</b><div class="muted">Machines that are not read-only can change things through it.</div></div>`}
        <div class="box row"><button class="btn" data-action="rename-profile" data-ref="${ref}">Rename</button><button class="btn red" data-action="delete-profile" data-ref="${ref}">Delete…</button></div>
      </div>
    </div>`;
};

VIEWS.add = () => {
  const services = Object.entries(PLUGIN_METADATA)
    .filter(([, m]) => m.addable)
    .map(([id]) => id)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const picked = state.ui.addService && services.includes(state.ui.addService) ? state.ui.addService : null;
  return html`
    <a class="muted" href="#profiles">Profiles ›</a>
    <h1>Add a profile</h1>
    <p class="muted">Profiles are added from a terminal on the hub. Pick the service to get the command.</p>
    <div class="tiles">${services.map((id) => html`
      <button class="box tile ${id === picked ? 'sel' : ''}" data-action="pick-service" data-service="${id}">${icon(id, 'lg')}<span>${displayName(id)}</span></button>`)}</div>
    ${picked ? html`<div class="box hl mt-16"><b>${displayName(picked)}: run this on the hub</b>
      <div class="codebox"><code>${addCommand(picked)}</code>${copyButton(addCommand(picked))}</div>
      <div class="row"><span class="muted grow">Then come back and press Refresh.</span><button class="btn" data-action="refresh">Refresh</button></div></div>` : ''}`;
};

ACTIONS['test-all'] = () => testProfiles(allRefs());
ACTIONS['pick-service'] = (el) => { state.ui.addService = el.dataset.service; render(); };
ACTIONS.refresh = async () => { if (await loadAll()) { render(); toast('Refreshed'); } };
ACTIONS['test-one'] = (el) => testProfiles([el.dataset.ref]);

ACTIONS['rename-profile'] = async (el) => {
  const ref = el.dataset.ref;
  const r = rowByRef(ref);
  if (!r) return;
  const name = await renameDialog(r.profile, ref);
  if (!name) return;
  const res = await api(`/ui/api/profiles/${refPath(ref)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  if (res.lost) return;
  if (!res.ok) { toast(res.error, 'error'); return; }
  const result = state.results.get(ref);
  state.results.delete(ref);
  if (result) state.results.set(`${r.service}/${name}`, result);
  await loadAll();
  toast(`Renamed to ${r.service}/${name}`);
  go({ view: 'profile', ref: `${r.service}/${name}` });
};

ACTIONS['delete-profile'] = async (el) => {
  const ref = el.dataset.ref;
  const r = rowByRef(ref);
  if (!r) return;
  const users = machinesUsing(state.keys, r).length;
  const ok = await confirmDialog({
    title: `Delete ${ref}?`,
    body: `Its credentials are removed from the vault${users ? ` and ${plural(users, 'machine')} lose${users === 1 ? 's' : ''} access to it` : ''}. This cannot be undone; to get it back, add it again on the hub.`,
    action: 'Delete profile',
  });
  if (!ok) return;
  const res = await api(`/ui/api/profiles/${refPath(ref)}`, { method: 'DELETE' });
  if (res.lost) return;
  if (!res.ok) { toast(res.error, 'error'); return; }
  state.results.delete(ref);
  await loadAll();
  toast(`Deleted ${ref}`);
  go({ view: 'profiles' });
};
