// Usage: how often each machine, profile and command used the vault's credentials, last 30 days.

const USAGE_DAYS = 30;
const USAGE_STALE_MS = 60_000;
let usageLoading = false;

VIEWS.usage = () => {
  const u = state.usage;
  if (!u || Date.now() - u.at > USAGE_STALE_MS) loadUsage();
  const head = pageHead({ title: 'Usage' });
  if (!u) return html`${head}<div class="readable"><p>Loading…</p></div>`;
  if (u.error) return html`${head}${banner(u.error, '', true)}`;
  const total = u.days.reduce((n, d) => n + d.count, 0);
  if (total === 0) {
    return html`${head}<div class="readable"><p>No usage recorded yet. Each time a command on this machine, or an agent through this hub, reads a profile's credentials, it shows up here.</p></div>`;
  }
  const now = Date.now();
  return html`${head}
    <div class="readable">
      <p>${plural(total, 'credential use')} in the last ${USAGE_DAYS} days.</p>
      ${dayChart(u.days, now)}
      ${usageTable('By machine', 'Machine · key', u.machines, now)}
      ${usageTable('By profile', 'Profile', u.profiles, now)}
      ${usageTable('By command', 'Command', u.commands, now)}
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

/** One bar a day, in UTC like the store's days. SVG attributes, not inline styles: the CSP allows no style attribute. */
function dayChart(days, now) {
  const counts = new Map(days.map((d) => [d.group, d.count]));
  const keys = Array.from({ length: USAGE_DAYS }, (_, i) => new Date(now - (USAGE_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  const max = Math.max(1, ...keys.map((k) => counts.get(k) || 0));
  const W = 8, GAP = 2, H = 60;
  return html`<div class="usage-box">
    <svg class="usage-chart" viewBox="0 0 ${USAGE_DAYS * (W + GAP)} ${H}" preserveAspectRatio="none" role="img" aria-label="Credential uses per day">
      ${keys.map((k, i) => {
        const n = counts.get(k) || 0;
        const h = n ? Math.max(2, Math.round((n / max) * H)) : 0;
        return html`<rect x="${i * (W + GAP)}" y="${H - h}" width="${W}" height="${h}"><title>${k}: ${n}</title></rect>`;
      })}
      <line class="baseline" x1="0" x2="${USAGE_DAYS * (W + GAP)}" y1="${H}" y2="${H}"></line>
    </svg>
    <div class="usage-axis"><span>${keys[0]}</span><span>max ${max}/day</span><span>Today</span></div>
  </div>`;
}

/** The failure rate; a few failures among many uses read "<1%", not a reassuring 0%. */
function failureRate(r) {
  const rounded = Math.round((r.failures / r.count) * 100);
  return r.failures > 0 && rounded === 0 ? '<1%' : `${rounded}%`;
}

function usageTable(title, label, rows, now) {
  return html`<h2>${title}</h2>
    <div class="table-box"><table class="grid">
      <thead><tr><th>${label}</th><th>Uses</th><th>Failed</th><th>Last seen</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td>${r.group}</td><td>${r.count}</td><td>${failureRate(r)}</td><td>${relativeTime(r.lastSeen, now)}</td></tr>`)}</tbody>
    </table></div>`;
}
