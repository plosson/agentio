// Overview: connect a machine first, then the profiles in the vault and the machines using it.

const RECENT = 5;
const PROFILES_SHOWN = 6;

VIEWS.overview = () => {
  const now = Date.now();
  const s = hubSummary(state.rows, state.keys, state.results, now);
  if (s.profiles === 0) return firstRun();
  const parts = attentionParts(attention(state.rows, state.keys, state.results, now));
  // The cards rise in once per visit, not on every redraw (a test result redraws the page).
  const enter = state.ui.entrance;
  state.ui.entrance = false;
  return html`
    ${pageHead({ title: 'Overview' })}
    ${parts.length ? banner(html`<span aria-hidden="true">!</span> ${parts.map((p, i) => html`${i ? ' · ' : ''}<a href="${p.href}">${p.text}</a>`)}`, '', true) : ''}
    <div class="overview${enter ? ' enter' : ''}">
      ${connectCard({ compact: state.keys.length > 0 })}
      <div class="overview-cards">${profilesCard(s, now)}${machinesCard(now)}</div>
    </div>`;
};

/** The profiles, problems first, each with its last test; Test all checks them one by one. */
function profilesCard(s, now) {
  const rows = problemsFirst(state.rows, state.results);
  const testing = rows.some((r) => effectiveStatus(r, state.results).status === 'testing');
  return html`<section class="card">
    <div class="card-head"><div><h2>Your profiles <span class="count">${rows.length}</span></h2>
      <p>${statusMarkup(overviewStatus(s, now))}</p></div>
      <button type="button" class="button" data-action="test-all" ${testing ? raw('disabled') : ''}>Test all</button></div>
    <ul class="rows">${rows.slice(0, PROFILES_SHOWN).map((r) => profileItem(r))}</ul>
    <div class="card-foot">${rows.length > PROFILES_SHOWN ? html`<a href="#profiles">Show all ${plural(rows.length, 'profile')}</a>` : ''}
      <a href="#add">＋ Add a profile</a></div>
  </section>`;
}

function profileItem(r) {
  const st = effectiveStatus(r, state.results);
  const sw = statusWord(st.status, isSession(r.service));
  // A result that just came in pops once; a later redraw shows it still.
  const popped = state.ui.popped || (state.ui.popped = new Set());
  const mark = `${refOf(r)}@${st.at}`;
  const pop = st.at !== undefined && st.status !== 'testing' && !popped.has(mark);
  if (pop) popped.add(mark);
  return html`<li><a href="${routeHash({ view: 'profile', ref: refOf(r) })}">${tile(r.service)}
    <span class="grow"><b>${accountShown(r.profile, r.account)}</b><span>${displayName(r.service)}</span></span>
    <span class="chip ${sw.tone}${pop ? ' pop' : ''}">${st.status === 'testing' ? html`<span class="spin" aria-hidden="true"></span>` : html`<span aria-hidden="true">${sw.symbol}</span>`} ${sw.word}</span></a></li>`;
}

/** The machines that may use the vault, last seen first; a slot waits for the first one. */
function machinesCard(now) {
  const machines = state.keys.length;
  const recent = recentlySeen(state.keys, RECENT);
  const arrived = state.ui.justConnected;
  state.ui.justConnected = null;
  return html`<section class="card">
    <div class="card-head"><div><h2>Connected machines <span class="count">${machines}</span></h2>
      <p>Every agent on a machine uses its access.</p></div></div>
    ${machines === 0
      ? html`<div class="slot"><span class="slot-icon">${MACHINE_GLYPH}</span>
          <b>Your first machine will appear here</b><span>Connect one above, then approve it.</span></div>`
      : html`<ul class="rows">${recent.map((k) => {
          const seen = machineSeen(k, now);
          return html`<li${k.id === arrived ? raw(' class="arrived"') : ''}><a href="${routeHash({ view: 'machine', id: k.id })}">
            <span class="machine-icon">${MACHINE_GLYPH}</span>
            <span class="grow"><b>${k.name}</b><span>Can use ${machineCanUse(k, allRefs())}${k.readOnly ? ' · read-only' : ''}</span></span>
            <span class="chip ${seen.tone}">${seen.tone === 'ok' && seenToday(k, now) ? html`<span class="live" aria-hidden="true"></span>` : html`<span aria-hidden="true">${seen.symbol}</span>`} ${seen.word}</span></a></li>`;
        })}</ul>
        <div class="card-foot"><a href="#machines">${machines > RECENT ? `Show all ${plural(machines, 'machine')}` : 'See all machines'}</a></div>`}
  </section>`;
}

// ---------- An empty vault: welcome ----------

/** The services the welcome page shows first, when this hub can add them. */
const FEATURED = ['gmail', 'gdrive', 'gcal', 'slack', 'github', 'jira', 'notes'];

/** What each service gives an agent, in a few words, for the welcome page's cards. */
const SERVICE_USE = {
  gmail: 'Read and send email', gdrive: 'Files and documents', gcal: 'Events and meetings', gchat: 'Spaces and messages',
  gdocs: 'Documents', gsheets: 'Spreadsheets', gslides: 'Presentations', gtasks: 'Tasks', slack: 'Channels and messages',
  github: 'Repositories and issues', jira: 'Issues and boards', confluence: 'Pages and spaces', spotify: 'Music and playlists',
  dropbox: 'Files', notes: 'Notes on this Mac', whatsapp: 'Chats', discourse: 'Forum posts', revolut: 'Accounts and payments',
  sql: 'A database', secrets: 'API keys and tokens', rss: 'Feeds', gscript: 'Scripts', falco: 'Accounting and invoices',
  kite: 'Pages you share', pocketalert: 'Push notifications', pagerio: 'Alerts on your iPhone and Mac',
  jev: 'Yes/no answers for scripts', claude: 'Ask Claude', chatgpt: 'Ask ChatGPT',
};

/** An empty vault: a welcome, the services to start with, then connecting a machine. */
function firstRun() {
  const { shown, more } = welcomeServices(addableServices(), FEATURED, Boolean(state.ui.allServices), displayName);
  return html`
    ${pageHead({ title: 'Overview' })}
    <div class="greeting">
      <div class="hello"><img class="welcome-icon" src="/ui/icon.svg?v=${state.version}" alt="">
        <div><h1>Welcome to your vault</h1>
          <p class="lede">Add the profiles your AI agents may use. Their passwords and keys stay here, locked; agents only ever get the access you allow.</p></div></div>
      <ol class="welcome-steps"><li class="now"><span class="n">1</span>Add a profile</li><li><span class="n">2</span>Connect a machine</li></ol>
      <h2>Add your first profile</h2>
      <div class="svc-grid">${shown.map((id) => html`<button type="button" class="svc-card" data-action="add-service" data-service="${id}">${tile(id)}<span><b>${displayName(id)}</b>${SERVICE_USE[id] ? html`<span class="what">${SERVICE_USE[id]}</span>` : ''}</span></button>`)}
        ${more ? html`<button type="button" class="svc-card more" data-action="all-services">All ${shown.length + more} services…</button>` : ''}</div>
      <div class="next"><span class="next-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 3h12v8H2zM5 13h6v1H5z"/></svg></span>
        <div class="grow"><b>Then connect a machine</b><span>Let the computer where your agent runs use the profiles you choose.</span></div>
        <a class="button" href="#connect">Connect a machine</a></div>
      <ul class="reassure"><li>Encrypted on this hub</li><li>You choose what each machine can use</li><li>Remove access at any time</li></ul>
    </div>`;
}

// ---------- Add one service: a sheet with its command ----------

ACTIONS['add-service'] = async (el) => {
  const service = el.dataset.service;
  if (!addableServices().includes(service)) return;
  if (addInApp(service)) return;
  $('add-dialog').innerHTML = html`
    <div class="sheet-head">${tile(service)}<h2 id="add-title">Add ${displayName(service)}</h2></div>
    <p>Run this in a terminal on the hub. It signs in to ${displayName(service)}, or asks for what it needs, such as a token.</p>
    ${command(addCommand(service))}
    <form method="dialog" class="actions">
      <button value="close" class="button">Close</button>
      <button value="check" class="button primary" autofocus>Check again</button>
    </form>`.__html;
  if ((await modal('add-dialog')) === 'check') ACTIONS['check-again']();
};

ACTIONS['all-services'] = () => { state.ui.allServices = true; render(); };
