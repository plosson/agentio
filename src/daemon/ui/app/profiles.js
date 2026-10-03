// Profiles: the list grouped by service, one profile with its fix, and adding one.

// Account and link, shown in full until space runs out, then cut with an ellipsis; the title holds the rest.
const accountText = (r) => (r.account ? html`<span class="clip" title="${r.account}">${r.account}</span>` : '');
const linkOut = (r) => (r.url && /^https?:\/\//i.test(r.url)
  ? html`<a class="ext" href="${r.url}" target="_blank" rel="noopener noreferrer" title="${r.url}"><span class="clip">${linkLabel(r.url)}</span><span aria-hidden="true">↗</span></a>`
  : '');

/** A profile's status, with when it was tested or why it failed. */
function profileStatusLine(r, now) {
  const st = effectiveStatus(r, state.results);
  const extra = st.status === 'invalid' ? (st.detail || 'no details were given')
    : st.status === 'ok' && st.at ? `tested ${relativeTime(st.at, now)}` : '';
  return html`${statusText(st.status, r.service)}${extra ? html` · ${extra}` : ''}`;
}

VIEWS.profiles = () => {
  const now = Date.now();
  const visible = filteredRows(state.rows);
  const groups = groupProfiles(visible, displayName);
  const actions = html`<div class="actions m-0">
    <button class="button" data-action="test-all" ${state.rows.length ? '' : raw('disabled')}>Test all</button>
    <a class="button primary" href="#add">Add a profile</a></div>`;
  if (state.rows.length === 0) {
    return html`${pageHead({ title: 'Profiles', count: 0, actions })}
      ${emptyState('No profiles yet. Profiles are added from a terminal on the hub.', html`<a class="button" href="#add">See how to add one</a>`)}`;
  }
  return html`
    ${pageHead({ title: 'Profiles', count: state.rows.length, actions })}
    ${filterBox(visible.length, state.rows.length)}
    ${visible.length === 0 ? noMatch() : html`<ul class="list">${groups.map((g) => html`
      <li class="group-heading">${icon(g.service)}<span>${g.name}</span></li>
      ${problemsFirst(g.rows, state.results).map((r) => listItem({
        href: routeHash({ view: 'profile', ref: refOf(r) }),
        title: r.profile,
        message: r.account || r.url ? html`<span class="details">${accountText(r)}${r.url ? html`<span class="clip">${linkLabel(r.url)}</span>` : ''}</span>` : '',
        meta: html`<span>${profileStatusLine(r, now)}</span>${r.readOnly ? html`<span>Read-only</span>` : ''}<span>used by ${plural(machinesUsing(state.keys, r).length, 'machine')}</span>`,
      }))}`)}</ul>`}`;
};

VIEWS.profile = (route) => {
  const r = rowByRef(route.ref);
  if (!r) return systemPage({ title: 'Not found', why: 'This profile was removed or renamed.', action: html`<a class="button" href="#profiles">Back to profiles</a>` });
  const now = Date.now();
  const st = effectiveStatus(r, state.results);
  const ref = refOf(r);
  const users = machinesUsing(state.keys, r);
  const fix = fixCommand(r.service, r.profile, Boolean(PLUGIN_METADATA[r.service]?.reauth));
  const sw = statusWord(st.status, isSession(r.service));
  const second = `${sw.symbol} ${sw.word}${st.status === 'ok' && st.at ? ` · tested ${relativeTime(st.at, now)}` : ''}`;
  const testing = st.status === 'testing';
  const testButton = (label) => html`<button class="button" data-action="test-one" data-ref="${ref}" ${testing ? raw('disabled') : ''}>${label}</button>`;

  const next = st.status === 'invalid'
    ? html`<p class="status bad mt-16"><span aria-hidden="true">✗</span> The last test failed: <span class="mono">${st.detail || 'no details were given'}</span></p>
        <p>To fix it, run this on the hub, then test again.</p>${command(fix)}<div class="actions">${testButton('Test again')}</div>`
    : st.status === 'no-creds'
      ? html`<p class="mt-16">This profile has no credentials yet. Run this on the hub, then test it.</p>${command(fix)}<div class="actions">${testButton('Test')}</div>`
      : html`<div class="actions">${testButton(testing ? 'Testing…' : 'Test')}</div>`;

  return html`
    ${pageHead({ path: [{ href: '#profiles', label: 'Profiles' }, { label: displayName(r.service) }], title: r.profile, rename: { key: `profile:${ref}`, submit: 'rename-profile' } })}
    <div class="columns">
      <section>
        ${displayPanel('Signed in as', r.account || (r.url ? linkLabel(r.url) : ref), second)}
        ${r.url && /^https?:\/\//i.test(r.url) ? html`<p class="note">${linkOut(r)}</p>` : ''}
        ${r.info && r.info !== r.account ? html`<p class="note">${r.info}</p>` : ''}
        ${next}
      </section>
      <section>
        <h2>Used by</h2>
        ${users.length
          ? html`<ul class="list">${users.map((u) => {
              const lvl = accessLevel(u.key, r);
              return listItem({ href: routeHash({ view: 'machine', id: u.key.id }), title: u.key.name, message: lvl.reason ? `${lvl.level}, ${lvl.reason}` : lvl.level });
            })}</ul>`
          : emptyState('No machine can use it. Give access from a machine’s page.')}
        <h2>Access</h2>
        ${r.readOnly
          ? html`<p><b>Read-only.</b> Machines can read through it but never change anything. To allow writes, run this on the hub:</p>
              ${command(allowWritesCommand(r.service, r.profile))}
              <p class="muted small">If it was signed in with read-only permissions, sign in again instead.</p>`
          : html`<p><b>Can write.</b> Machines that aren’t read-only can change things through it.</p>`}
        <h2>Danger zone</h2>
        <div class="actions"><button class="button danger" data-action="delete-profile" data-ref="${ref}">Delete profile…</button></div>
      </section>
    </div>`;
};

VIEWS.add = () => {
  const services = Object.entries(PLUGIN_METADATA)
    .filter(([, m]) => m.addable)
    .map(([id]) => id)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const query = state.ui.serviceFilter || '';
  const shown = services.filter((id) => matchesService(id, query, displayName));
  const picked = state.ui.addService && services.includes(state.ui.addService) ? state.ui.addService : null;
  return html`
    ${pageHead({ path: [{ href: '#profiles', label: 'Profiles' }], title: 'Add a profile' })}
    <div class="readable">
      <p class="muted">Profiles are added from a terminal on the hub. Choose the service to get the command.</p>
      ${picked ? html`<section class="mb-24"><h2>${displayName(picked)}: run this on the hub</h2>${command(addCommand(picked))}
        <div class="actions"><button class="button" data-action="check-again">Check again</button>
          <button class="button link" data-action="pick-service" data-service="">Choose another service</button></div></section>` : ''}
      <input type="search" id="service-filter" class="input" data-input="service-filter" value="${query}"
        placeholder="Filter services" aria-label="Filter services" autocomplete="off" spellcheck="false">
      ${shown.length === 0
        ? html`<div class="mt-16">${emptyState(html`No service matches “${query}”.`)}</div>`
        : html`<ul class="list mt-16">${shown.map((id) => html`<li><button type="button" class="item no-dot ${id === picked ? 'chosen' : ''}"
            data-action="pick-service" data-service="${id}" aria-pressed="${id === picked ? 'true' : 'false'}">
            <span class="svc">${icon(id)}<span class="item-title">${displayName(id)}</span></span></button></li>`)}</ul>`}
    </div>`;
};

ACTIONS['test-all'] = () => testProfiles(allRefs());
ACTIONS['test-one'] = (el) => testProfiles([el.dataset.ref]);

ACTIONS['pick-service'] = (el) => {
  state.ui.addService = el.dataset.service || null;
  render();
  window.scrollTo(0, 0);
};

INPUTS['service-filter'] = (input) => { state.ui.serviceFilter = input.value; render(); };

/** Reloads the profiles after a command on the hub, and says what is new. */
ACTIONS['check-again'] = async () => {
  const before = new Set(allRefs());
  if (!(await loadAll())) return;
  const added = allRefs().filter((ref) => !before.has(ref));
  render();
  toast(added.length ? `Added ${added.join(', ')}` : 'No new profile yet.');
};

SUBMITS['rename-profile'] = async (form) => {
  const ref = form.dataset.key.slice('profile:'.length);
  const r = rowByRef(ref);
  const name = form.elements.name.value.trim();
  if (!r || name === r.profile) { ACTIONS['cancel-rename'](); return; }
  state.ui.renameDraft = name;
  if (!name) { state.ui.renameError = 'Give the profile a name.'; render(); return; }
  const res = await api(`/ui/api/profiles/${refPath(ref)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  if (res.lost) return;
  if (!res.ok) { state.ui.renameError = res.error; render(); return; }
  const result = state.results.get(ref);
  state.results.delete(ref);
  if (result) state.results.set(`${r.service}/${name}`, result);
  state.ui.renaming = null;
  state.ui.renameError = '';
  state.ui.renameDraft = undefined;
  await loadAll();
  toast(`Renamed to ${name}`);
  go({ view: 'profile', ref: `${r.service}/${name}` });
};

ACTIONS['delete-profile'] = async (el) => {
  const ref = el.dataset.ref;
  const r = rowByRef(ref);
  if (!r) return;
  const users = machinesUsing(state.keys, r).length;
  const ok = await confirmDialog({
    title: `Delete ${ref}?`,
    body: `Its credentials are removed from the vault${users ? ` and ${plural(users, 'machine')} lose${users === 1 ? 's' : ''} access to it` : ''}. This can't be undone; to get it back, add it again on the hub.`,
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
