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
    ${parts.length ? banner(html`<span aria-hidden="true">!</span> ${parts.map((p, i) => html`${i ? ' · ' : ''}<a href="${p.href}">${p.text}</a>`)}`, '', true) : ''}
    ${pageHead({ title: 'Overview' })}
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
              ${machines > RECENT ? html`<li class="more"><span>${plural(machines, 'machine')}</span><a href="#machines">Show all ${plural(machines, 'machine')}</a></li>` : ''}</ul>`}
      </section>
    </div>`;
};

/** An empty vault: the two steps to get started. */
function firstRun() {
  return html`
    ${pageHead({ title: 'Overview' })}
    <div class="readable">
      <p>Nothing in the vault yet. Two steps get an agent going.</p>
      <ol class="steps">
        <li><b>Add a profile on the hub.</b> For example, for Gmail:${command(addCommand('gmail'))}<a href="#add">See every service</a></li>
        <li><b>Connect a machine</b>, so an agent can use the profile. <a href="#connect">Connect a machine</a></li>
      </ol>
    </div>`;
}
