// Overview: what needs the owner, then the hub at a glance. Tests run only when asked.

VIEWS.overview = () => {
  const now = Date.now();
  const items = needsYou(state.pending, state.rows, state.results, state.keys);
  const s = hubSummary(state.rows, state.keys, state.results, now);
  const services = [...new Set(state.rows.map((r) => r.service))].sort();
  const title = items.length ? `${plural(items.length, 'thing')} need${items.length === 1 ? 's' : ''} you` : 'Nothing needs you';
  const tested = s.testedAt ? `Profiles last tested at ${clockTime(s.testedAt)}, when you pressed Test all.` : 'Profiles are tested only when you ask.';

  const needs = items.map((item) => item.kind === 'sign-in'
    ? html`<div class="box hl row"><span class="grow"><b>${item.request.name} wants access</b> · code ${item.request.userCode} · asked ${relativeTime(item.request.createdAt, now)}</span>
        <button class="btn" data-action="deny-sign-in" data-code="${item.request.userCode}">Deny</button>
        <a class="btn pri" href="${routeHash({ view: 'authorize', code: item.request.userCode })}">Review</a></div>`
    : html`<div class="box alert row"><span class="grow">${profileLabel(item.row)} <b>is not working</b>${item.at ? html` · failed the ${clockTime(item.at)} test` : ''} · used by ${plural(item.usedBy, 'machine')}</span>
        <a class="btn pri" href="${routeHash({ view: 'profile', ref: refOf(item.row) })}">Fix</a></div>`);

  return html`
    <div class="row"><div class="grow"><h1>${title}</h1><span class="muted">${tested}</span></div>
      <button class="btn" data-action="test-all" ${state.rows.length ? '' : raw('disabled')}>Test all</button></div>
    ${items.length ? html`<div class="section-title"><span class="n">1</span>Needs you</div><div class="col">${needs}</div>` : ''}
    <div class="section-title"><span class="n">${items.length ? 2 : 1}</span>Your hub</div>
    <div class="grid3">
      <a class="sketch plain" href="#profiles"><b>${plural(s.profiles, 'profile')}</b>
        <div>${s.testedAt ? html`Tested ${clockTime(s.testedAt)}: ${s.working} working${s.failing ? html` · <span class="text-red">${s.failing} not working</span>` : ''}` : 'Not tested in this session'}</div>
        <div class="icons">${services.map((svc) => icon(svc))}</div></a>
      <a class="sketch plain" href="#machines"><b>${plural(s.machines, 'machine')}</b>
        <div>${s.seenToday} seen today${s.silent ? html` · <span class="text-amber">${s.silent} silent for over ${SILENT_DAYS} days</span>` : ''}</div></a>
      <a class="sketch plain" href="#settings"><b>Hub</b><div>Unlocked · ${state.version ? 'v' + state.version : ''}</div></a>
    </div>`;
};

ACTIONS['test-all'] = () => testProfiles(allRefs());

ACTIONS['deny-sign-in'] = async (el) => {
  const res = await api(`/ui/api/authorize/${encodeURIComponent(el.dataset.code)}`, { method: 'POST', body: JSON.stringify({ approve: false }) });
  if (res.lost) return;
  if (res.ok || res.status === 404) toast(res.ok ? 'Denied. The terminal is told no.' : 'That request had already ended.');
  else toast(res.error, 'error');
  await loadPending();
  render();
};
