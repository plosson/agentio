// Who can use what, as the Access view of Machines: machines across, profiles down.
// A cell gives or removes access. On narrow screens access is changed from each machine's page.

VIEWS.access = () => {
  const now = Date.now();
  const keys = [...state.keys].sort((a, b) => a.name.localeCompare(b.name));
  const rows = groupProfiles(filteredRows(state.rows), displayName).flatMap((g) => g.rows);
  const head = pageHead({ path: [{ href: '#machines', label: 'Machines' }], title: 'Access' });
  if (keys.length === 0) return html`${head}${emptyState('No machines yet. Connect one first.', html`<a class="button" href="#connect">Connect a machine</a>`)}`;
  if (state.rows.length === 0) return html`${head}${emptyState('No profiles yet. Profiles are added from a terminal on the hub.', html`<a class="button" href="#add">See how to add one</a>`)}`;

  return html`${head}
    <div class="phone-only-view"><p>Change access from each machine’s page.</p><ul class="list">${keys.map((k) => machineItem(k, now))}</ul></div>
    <div class="wide-only-view">
      <p class="muted">Click a cell to give or remove access. A machine can write only if neither it nor the profile is read-only.</p>
      ${filterBox(rows.length, state.rows.length)}
      ${rows.length === 0 ? noMatch() : html`<div class="table-box"><table class="grid">
        <thead><tr><th scope="col">Profile</th>${keys.map((k) => html`<th scope="col" class="center"><a href="${routeHash({ view: 'machine', id: k.id })}">${k.name}</a>${k.readOnly ? html`<br><span class="small">read-only</span>` : ''}</th>`)}</tr></thead>
        <tbody>${rows.map((r) => html`<tr>
          <th scope="row"><a href="${routeHash({ view: 'profile', ref: refOf(r) })}">${profileLabel(r)}</a>${r.readOnly ? html` <span class="muted small">read-only</span>` : ''}</th>
          ${keys.map((k) => {
            const cell = accessCell(k, r);
            const label = `${cell === 'None' ? 'Give' : 'Remove'} ${k.name} ${cell === 'None' ? 'access to' : 'from'} ${refOf(r)}`;
            return html`<td class="cell ${cell.toLowerCase()}"><button data-action="toggle-cell" data-id="${k.id}" data-ref="${refOf(r)}" aria-label="${label}" title="${label}">${cell}</button></td>`;
          })}
        </tr>`)}</tbody>
      </table></div>`}
    </div>`;
};

ACTIONS['toggle-cell'] = async (el) => {
  const key = keyById(el.dataset.id);
  if (!key) return;
  const change = toggleScope(key, el.dataset.ref, allRefs());
  if ('error' in change) {
    toast(change.error, 'error', { href: routeHash({ view: 'machine', id: key.id }), label: 'Revoke instead' });
    return;
  }
  el.disabled = true;
  const res = await api(`/ui/api/keys/${encodeURIComponent(key.id)}`, { method: 'PATCH', body: JSON.stringify({ allowedProfiles: change.allowedProfiles }) });
  if (res.lost) return;
  if (!res.ok) { el.disabled = false; toast(res.error, 'error'); return; }
  state.keys = state.keys.map((k) => (k.id === key.id ? res.body : k));
  const now = res.body.allowedProfiles.includes(el.dataset.ref);
  toast(now ? `${key.name} can use ${el.dataset.ref}` : `${key.name} can no longer use ${el.dataset.ref}`);
  render();
};
