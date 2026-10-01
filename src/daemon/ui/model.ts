/**
 * What the admin page decides without touching the page: escaping, routes,
 * the wording of times and commands, who can use what, and what needs the
 * owner. assets.ts transpiles this file into the page's script, so it must
 * stay free of imports and of DOM, Node and Bun APIs. Tests import it directly.
 */

// ---------- Markup ----------

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Markup that `html` inserts as is. Made only by `raw()` and `html`. */
export interface Raw {
  readonly __html: string;
}

const RAW = new WeakSet<object>();

export function raw(markup: string): Raw {
  const value = { __html: markup };
  RAW.add(value);
  return value;
}

function piece(value: unknown): string {
  if (Array.isArray(value)) return value.map(piece).join('');
  if (typeof value === 'object' && value !== null && RAW.has(value)) return (value as Raw).__html;
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

/** Markup with every interpolation escaped, except `raw()` and nested `html` results; arrays join. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  values.forEach((value, i) => {
    out += piece(value) + strings[i + 1];
  });
  return raw(out);
}

// ---------- Routes ----------

export type TabView = 'overview' | 'machines' | 'profiles' | 'access' | 'settings' | 'add';
export type Route =
  | { view: TabView }
  | { view: 'machine'; id: string }
  | { view: 'profile'; ref: string }
  | { view: 'authorize'; code: string };

const TAB_VIEWS: readonly string[] = ['overview', 'machines', 'profiles', 'access', 'settings', 'add'];

/** `#machines`, `#machine=<id>`, `#profile=<service>/<name>`, `#authorize=<code>`; anything else is the overview. */
export function parseRoute(hash: string): Route {
  let text = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    text = decodeURIComponent(text);
  } catch {
    return { view: 'overview' };
  }
  const eq = text.indexOf('=');
  if (eq === -1) return TAB_VIEWS.includes(text) ? { view: text as TabView } : { view: 'overview' };
  const name = text.slice(0, eq);
  const value = text.slice(eq + 1);
  if (name === 'machine' && value) return { view: 'machine', id: value };
  if (name === 'profile' && /^[^/]+\/.+$/.test(value)) return { view: 'profile', ref: value };
  if (name === 'authorize' && value) return { view: 'authorize', code: value };
  return { view: 'overview' };
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case 'machine':
      return `#machine=${encodeURIComponent(route.id)}`;
    case 'profile':
      return `#profile=${encodeURIComponent(route.ref)}`;
    case 'authorize':
      return `#authorize=${encodeURIComponent(route.code)}`;
    default:
      return `#${route.view}`;
  }
}

/** The navigation tab to highlight; the sign-in page has none. */
export function tabOf(route: Route): 'overview' | 'machines' | 'profiles' | 'access' | 'settings' | null {
  switch (route.view) {
    case 'machine':
      return 'machines';
    case 'profile':
    case 'add':
      return 'profiles';
    case 'authorize':
      return null;
    default:
      return route.view;
  }
}

// ---------- Times ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;
const pad = (n: number): string => String(n).padStart(2, '0');

export function shortDate(t: number, now: number): string {
  const d = new Date(t);
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

export function clockTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(when: string | number | undefined, now: number): string {
  if (when === undefined || when === '') return 'never';
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (Number.isNaN(t)) return 'never';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.floor((now - t) / DAY_MS);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return shortDate(t, now);
}

export function timeLeft(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return 'ended';
  if (ms < 60_000) return 'ends in less than a minute';
  return `ends in ${Math.ceil(ms / 60_000)} min`;
}

// ---------- Words and commands ----------

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A word a POSIX shell reads back unchanged. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function reauthCommand(service: string, profile: string): string {
  return `agentio profile reauth ${shellQuote(service)} ${shellQuote(profile)}`;
}

export function addCommand(service: string): string {
  return `agentio ${shellQuote(service)} profile add`;
}

export function loginCommand(origin: string): string {
  return `agentio login ${shellQuote(origin)}`;
}
