// Usage: how often each machine, profile and command used the vault's credentials, last 30 days.

const USAGE_DAYS = 30;
const USAGE_STALE_MS = 60_000;
/** Services the chart gives a colour of their own; the rest share one grey part. */
const CHART_SERVICES = 6;
/** Chart colours for services without a brand colour of their own: .usage-chart .c0 to .c5 in admin.css. */
const CHART_PALETTE = 6;
/** Rows a card shows until "Show more" is pressed, so the cards side by side stay short and level. */
const USAGE_ROWS = 5;
let usageLoading = false;

const USAGE_GLYPHS = {
  uses: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14h12v1H2zM3 9h2v4H3zM7 5h2v8H7zM11 7h2v6h-2z"/></svg>`,
  machines: MACHINE_GLYPH,
  profiles: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5z"/></svg>`,
  ok: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 11.2 3.3 8l-1 1 4.2 4.2 7.2-7.2-1-1z"/></svg>`,
  bad: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3h2v7H7zM7 11.5h2v2H7z"/></svg>`,
  command: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.3 3.6 3.2 7.4 7l-3.8 3.8-1.1-1.1L5.2 7zM8 11.5h5.5V13H8z"/></svg>`,
};

VIEWS.usage = () => {
  const u = state.usage;
  if (!u || Date.now() - u.at > USAGE_STALE_MS) loadUsage();
  const head = pageHead({ title: 'Usage' });
  if (!u) return html`${head}<div class="readable"><p>Loading…</p></div>`;
  if (u.error) return html`${head}${banner(u.error, '', true)}`;
  const total = u.profiles.reduce((n, r) => n + r.count, 0);
  if (total === 0) {
    return html`${head}<div class="readable"><p>No usage recorded yet. Each time a command on this machine, or an agent through this hub, reads a profile's credentials, it shows up here.</p></div>`;
  }
  const now = Date.now();
  const failures = u.profiles.reduce((n, r) => n + r.failures, 0);
  return html`${head}
    <div class="usage">
      <div class="usage-stats">
        ${usageStat('uses', 'uses', total, `${total === 1 ? 'use' : 'uses'} in the last ${USAGE_DAYS} days`)}
        ${usageStat('machines', 'machines', u.machines.length, u.machines.length === 1 ? 'machine' : 'machines')}
        ${usageStat('profiles', 'profiles', u.profiles.length, u.profiles.length === 1 ? 'profile used' : 'profiles used')}
        ${failures
          ? usageStat('bad', 'bad', failureChip(failures, total).percent, `failed, ${failures} of ${total}`)
          : usageStat('ok', 'ok', '0%', 'failed')}
      </div>
      ${chartCard(u.daily, now)}
      <div class="overview-cards usage-cards${['machines', 'profiles'].some((id) => state.ui.usageAll?.has(id)) ? ' open' : ''}">
        ${usageCard('machines', 'Machines', 'Who asked for credentials.', u.machines, (r) => machineRow(r, total, now))}
        ${usageCard('profiles', 'Profiles', 'Which credentials they used.', u.profiles, (r) => profileRow(r, total, now))}
      </div>
      ${usageCard('commands', 'Commands', 'What they ran with them.', u.commands, (r) => commandRow(r, total, now))}
    </div>`;
};

async function loadUsage() {
  if (usageLoading) return;
  usageLoading = true;
  const res = await api('/ui/api/usage');
  usageLoading = false;
  if (res.lost) return;
  state.usage = res.ok ? { ...res.body, at: Date.now() } : { error: res.error, at: Date.now() };
  if (currentRoute().view === 'usage') render();
}

function usageStat(tone, glyphName, value, label) {
  return html`<div class="usage-stat ${tone}"><span class="usage-stat-icon">${USAGE_GLYPHS[glyphName]}</span>
    <span><b>${value}</b><span>${label}</span></span></div>`;
}

/** A fill as SVG attributes: the brand colour, or a palette class. The CSP allows no style attribute. */
function fillAttrs(paint) {
  if (!paint) return raw('class="other"');
  return 'colour' in paint ? html`fill="${paint.colour}"` : html`class="c${paint.slot}"`;
}

/** One bar a day, in UTC like the store's days, split by service; the top services in colour, the rest grey. */
function chartCard(daily, now) {
  const days = usageDays(now, USAGE_DAYS);
  const { stacks, services, other, max } = usageStacks(daily, days, CHART_SERVICES);
  const paints = new Map(chartColours(services, serviceColour, CHART_PALETTE).map((p, i) => [services[i], p]));
  const totals = new Map();
  for (const s of stacks) for (const p of s.parts) totals.set(p.service, (totals.get(p.service) || 0) + p.count);
  const W = 8, GAP = 3, H = 100;
  const width = USAGE_DAYS * (W + GAP) - GAP;
  const top = Math.max(1, max);
  const busiest = stacks.reduce((a, b) => (b.total > a.total ? b : a), stacks[0]);
  return html`<section class="card usage-chart-card">
    <div class="card-head"><div><h2>Every day</h2>
      <p>Busiest day ${busiest.day}, with ${plural(busiest.total, 'use')}.</p></div></div>
    <div class="usage-plot">
      <svg class="usage-chart" viewBox="0 0 ${width} ${H}" preserveAspectRatio="none" role="img" aria-label="Credential uses per day, by service">
        ${[0.5, 1].map((f) => html`<line class="grid" x1="0" x2="${width}" y1="${H - f * H}" y2="${H - f * H}"></line>`)}
        ${stacks.map((s, i) => {
          let y = H;
          return s.parts.map((p) => {
            const h = (p.count / top) * H;
            y -= h;
            const name = p.service === OTHER_SERVICES ? 'Other services' : displayName(p.service);
            return html`<rect x="${i * (W + GAP)}" y="${y}" width="${W}" height="${h}" ${fillAttrs(paints.get(p.service))}><title>${s.day} · ${name}: ${p.count}</title></rect>`;
          });
        })}
        <line class="baseline" x1="0" x2="${width}" y1="${H}" y2="${H}"></line>
      </svg>
      <div class="usage-axis"><span>${days[0]}</span><span>${max} a day at most</span><span>Today</span></div>
    </div>
    <ul class="usage-legend">
      ${services.map((s) => html`<li>${swatch(paints.get(s))}${displayName(s)} <span>${totals.get(s)}</span></li>`)}
      ${other ? html`<li>${swatch(null)}Other <span>${totals.get(OTHER_SERVICES)}</span></li>` : ''}
    </ul>
  </section>`;
}

function swatch(paint) {
  return html`<svg class="swatch" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="3" ${fillAttrs(paint)}></rect></svg>`;
}

/** A card of rows, the first USAGE_ROWS of them until the owner asks for all. */
function usageCard(id, title, lede, rows, row) {
  const all = Boolean(state.ui.usageAll?.has(id));
  const hidden = rows.length - USAGE_ROWS;
  return html`<section class="card usage-card">
    <div class="card-head"><div><h2>${title} <span class="count">${rows.length}</span></h2><p>${lede}</p></div></div>
    <ul class="rows usage-rows">${(all ? rows : rows.slice(0, USAGE_ROWS)).map(row)}</ul>
    ${hidden > 0 ? html`<div class="card-foot"><button type="button" class="button link" data-action="usage-more" data-card="${id}">${all ? 'Show fewer' : `Show ${hidden} more`}</button></div>` : ''}
  </section>`;
}

ACTIONS['usage-more'] = (el) => {
  const all = state.ui.usageAll || (state.ui.usageAll = new Set());
  if (!all.delete(el.dataset.card)) all.add(el.dataset.card);
  render();
};

/** A row's share of all uses, as a thin bar in its colour. */
function shareBar(count, total, colour) {
  const share = usageShare(count, total);
  return html`<svg class="share" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="4"></rect><rect width="${share}" height="4" ${colour ? html`fill="${colour}"` : raw('class="plain"')}></rect></svg>`;
}

/** A row: a link when there is a page to go to. */
function usageRow({ href, lead, title, sub, r, total, colour, now }) {
  const chip = failureChip(r.failures, r.count);
  const inner = html`${lead}
    <span class="grow"><b>${title}</b><span>${sub}</span>${shareBar(r.count, total, colour)}</span>
    <span class="usage-count"><b>${r.count}</b><span>${relativeTime(r.lastSeen, now)}</span></span>
    <span class="chip ${chip.tone}">${chip.tone === 'bad' ? html`<span class="wide-only">${r.failures} failed · </span>${chip.percent}` : chip.word}</span>`;
  return html`<li>${href ? html`<a href="${href}">${inner}</a>` : html`<div class="row">${inner}</div>`}</li>`;
}

function machineRow(r, total, now) {
  const local = r.keyId === 'local';
  return usageRow({
    href: keyById(r.keyId) ? routeHash({ view: 'machine', id: r.keyId }) : '',
    lead: html`<span class="machine-icon">${MACHINE_GLYPH}</span>`,
    title: r.host,
    sub: local ? 'Commands run on this hub' : `Key ${r.keyName}`,
    r, total, now,
  });
}

function profileRow(r, total, now) {
  const { service, profile } = splitRef(r.group);
  return usageRow({
    href: rowByRef(r.group) ? routeHash({ view: 'profile', ref: r.group }) : '',
    lead: tile(service),
    title: profile,
    sub: displayName(service),
    colour: serviceColour(service),
    r, total, now,
  });
}

function commandRow(r, total, now) {
  const service = commandService(r.group, Object.keys(PLUGIN_METADATA));
  const reported = r.group !== 'unknown' && r.group !== 'invalid';
  return usageRow({
    lead: service ? tile(service) : html`<span class="machine-icon">${USAGE_GLYPHS.command}</span>`,
    title: reported ? html`<code>agentio ${r.group}</code>` : 'Not reported',
    sub: reported ? (service ? displayName(service) : 'agentio') : 'The agent did not say which command it ran',
    colour: service ? serviceColour(service) : '',
    r, total, now,
  });
}
