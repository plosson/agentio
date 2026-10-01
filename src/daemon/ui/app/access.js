// Who can use what: machines across, profiles down. A cell gives or removes access.

VIEWS.access = () => {
  const keys = [...state.keys].sort((a, b) => a.name.localeCompare(b.name));
  const rows = groupProfiles(filteredRows(state.rows), displayName).flatMap((g) => g.rows);
  if (keys.length === 0) return html`<h1>Who can use what</h1><div class="box empty mt-12"><h2>No machines yet.</h2><p class="muted">Connect one from Machines.</p><a class="btn pri" href="#machines">Machines</a></div>`;
  if (state.rows.length === 0) return html`<h1>Who can use what</h1><div class="box empty mt-12"><h2>No profiles yet.</h2><a class="btn pri" href="#add">Add a profile</a></div>`;

  return html`
    <h1>Who can use what</h1>
    <span class="muted">Click a cell to give or remove access. W = can write, R = read-only, · = no access. A machine writes only if neither it nor the profile is read-only.</span>
    ${filterBox(rows.length, state.rows.length)}
    ${rows.length === 0 ? noMatch() : html`<div class="box mt-12 scroll-x"><table>
      <tr><th></th>${keys.map((k) => html`<th class="cell"><a href="${routeHash({ view: 'machine', id: k.id })}">${k.name}</a>${k.readOnly ? html`<br><span class="pill ro">read-only</span>` : ''}</th>`)}</tr>
      ${rows.map((r) => {
        const st = effectiveStatus(r, state.results).status;
        return html`<tr>
          <td><a href="${routeHash({ view: 'profile', ref: refOf(r) })}">${profileLabel(r)}</a>
            ${r.readOnly ? html` <span class="pill ro">read-only</span>` : ''}${st === 'invalid' ? html` ${pill(st, r.service)}` : ''}</td>
          ${keys.map((k) => {
            const cell = accessCell(k, r);
            const cls = cell === 'W' ? 'w' : cell === 'R' ? 'r' : 'no';
            const label = `${cell === '·' ? 'Give' : 'Remove'} ${k.name} ${cell === '·' ? 'access to' : 'from'} ${refOf(r)}`;
            return html`<td class="cell ${cls}"><button data-action="toggle-cell" data-id="${k.id}" data-ref="${refOf(r)}" aria-label="${label}" title="${label}">${cell}</button></td>`;
          })}
        </tr>`;
      })}
    </table></div>`}`;
};

ACTIONS['toggle-cell'] = async (el) => {
  const key = keyById(el.dataset.id);
  if (!key) return;
  const change = toggleScope(key, el.dataset.ref, allRefs());
  if ('error' in change) { toast(change.error, 'error'); return; }
  el.disabled = true;
  const res = await api(`/ui/api/keys/${encodeURIComponent(key.id)}`, { method: 'PATCH', body: JSON.stringify({ allowedProfiles: change.allowedProfiles }) });
  if (res.lost) return;
  if (!res.ok) { el.disabled = false; toast(res.error, 'error'); return; }
  state.keys = state.keys.map((k) => (k.id === key.id ? res.body : k));
  const now = res.body.allowedProfiles.includes(el.dataset.ref);
  toast(now ? `${key.name} can use ${el.dataset.ref}` : `${key.name} can no longer use ${el.dataset.ref}`);
  render();
};
