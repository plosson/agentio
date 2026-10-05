// Overview: is everything all right? What is in the vault, and which machines use it.

const RECENT = 5;

VIEWS.overview = () => {
  const now = Date.now();
  const s = hubSummary(state.rows, state.keys, state.results, now);
  if (s.profiles === 0) return firstRun();
  const parts = attentionParts(attention(state.rows, state.keys, state.results, now));
  const recent = recentlySeen(state.keys, RECENT);
  const machines = state.keys.length;
  return html`
    ${pageHead({ title: 'Overview' })}
    ${parts.length ? banner(html`<span aria-hidden="true">!</span> ${parts.map((p, i) => html`${i ? ' · ' : ''}<a href="${p.href}">${p.text}</a>`)}`, '', true) : ''}
    <div class="columns">
      <section>
        ${displayPanel('In the vault', listSummary(serviceNames(state.rows, displayName)))}
        <p class="note">${plural(s.profiles, 'profile')}. ${machines ? `${plural(machines, 'machine')} connected.` : 'No machine connected yet.'}</p>
        <p class="mt-8">${statusMarkup(overviewStatus(s, now))}</p>
        <div class="actions">
          <button class="button" data-action="test-all">Test all</button>
          <a class="button primary" href="#connect">Connect a machine</a>
        </div>
      </section>
      <section>
        <h2>Recently seen</h2>
        ${recent.length === 0
          ? emptyState('No machines yet. Connect one so an agent can use the vault.')
          : html`<ul class="list">${recent.map((k) => machineItem(k, now))}
              ${machines > RECENT ? html`<li class="more"><a href="#machines">Show all ${plural(machines, 'machine')}</a></li>` : ''}</ul>`}
      </section>
    </div>`;
};

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
};

/** An empty vault: a welcome, the services to start with, then connecting a machine. */
function firstRun() {
  const { shown, more } = welcomeServices(addableServices(), FEATURED, Boolean(state.ui.allServices), displayName);
  return html`
    ${pageHead({ title: 'Overview' })}
    <div class="greeting">
      <div class="hello"><img class="welcome-icon" src="/ui/icon.svg?v=${state.version}" alt="">
        <div><h1>Welcome to your vault</h1>
          <p class="lede">Add the accounts your AI agents may use. Their passwords and keys stay here, locked; agents only ever get the access you allow.</p></div></div>
      <ol class="welcome-steps"><li class="now"><span class="n">1</span>Add an account</li><li><span class="n">2</span>Connect a machine</li></ol>
      <h2>Add your first account</h2>
      <div class="svc-grid">${shown.map((id) => html`<button type="button" class="svc-card" data-action="add-service" data-service="${id}">${tile(id)}<span><b>${displayName(id)}</b>${SERVICE_USE[id] ? html`<span class="what">${SERVICE_USE[id]}</span>` : ''}</span></button>`)}
        ${more ? html`<button type="button" class="svc-card more" data-action="all-services">All ${shown.length + more} services…</button>` : ''}</div>
      <div class="next"><span class="next-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 3h12v8H2zM5 13h6v1H5z"/></svg></span>
        <div class="grow"><b>Then connect a machine</b><span>Let the computer where your agent runs use the accounts you choose.</span></div>
        <a class="button" href="#connect">Connect a machine</a></div>
      <ul class="reassure"><li>Encrypted on this hub</li><li>You choose what each machine can use</li><li>Remove access at any time</li></ul>
    </div>`;
}

// ---------- Add one service: a sheet with its command ----------

ACTIONS['add-service'] = async (el) => {
  const service = el.dataset.service;
  if (!addableServices().includes(service)) return;
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
