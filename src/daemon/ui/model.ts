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

export type TabView = 'overview' | 'machines' | 'profiles' | 'access' | 'settings' | 'add' | 'connect' | 'key';
export type Route =
  | { view: TabView }
  | { view: 'machine'; id: string }
  | { view: 'profile'; ref: string }
  | { view: 'authorize'; code: string };

const TAB_VIEWS: readonly string[] = ['overview', 'machines', 'profiles', 'access', 'settings', 'add', 'connect', 'key'];

/** `#machines`, `#machine=<id>`, `#profile=<service>/<name>`, `#authorize=<code>`; anything else is the Overview. */
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
export function tabOf(route: Route): 'overview' | 'machines' | 'profiles' | 'settings' | null {
  switch (route.view) {
    case 'machine':
    case 'access':
    case 'connect':
    case 'key':
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

/**
 * Which list sits beside the details, and whether one of its rows is open there.
 * On a narrow screen only one shows: the details when a row is open, else the list.
 */
export function paneOf(route: Route): { list: 'profiles' | 'machines' | null; selected: boolean } {
  switch (route.view) {
    case 'profiles':
      return { list: 'profiles', selected: false };
    case 'profile':
      return { list: 'profiles', selected: true };
    case 'machines':
      return { list: 'machines', selected: false };
    case 'machine':
      return { list: 'machines', selected: true };
    default:
      return { list: null, selected: false };
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

/** A live countdown: "4:12 left", "1:02:05 left"; "ended" at or past the end, or for a date that can't be read. */
export function countdown(expiresAt: string, now: number): string {
  const s = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  if (!(s > 0)) return 'ended';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)} left` : `${m}:${pad(sec)} left`;
}

// ---------- Words and commands ----------

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Up to `max` names, then "N more"; when only one would be left over, it is shown instead of "1 more". */
export function listSummary(names: string[], max = 3): string {
  if (names.length <= max + 1) return names.join(' · ');
  return `${names.slice(0, max).join(' · ')} · ${names.length - max} more`;
}

/** The account to show next to a profile's name; empty when it only repeats the name. */
export function accountShown(profile: string, account: string | undefined): string {
  const a = (account ?? '').trim();
  return a.toLowerCase() === profile.trim().toLowerCase() ? '' : a;
}

/** The services of these profiles by display name, once each, sorted. Falls back to the id. */
export function serviceNames(rows: Array<Pick<ProfileRow, 'service'>>, displayName: (service: string) => string): string[] {
  return [...new Set(rows.map((r) => displayName(r.service) || r.service))].sort((a, b) => a.localeCompare(b));
}

/** A word a POSIX shell reads back unchanged. */
/**
 * The services an empty vault's welcome page offers: the featured ones this hub can add, in their
 * order, with how many more there are; or every addable one, by display name. When none of the
 * featured ones is addable, every addable one shows, so the page is never empty while services exist.
 */
export function welcomeServices(addable: string[], featured: readonly string[], all: boolean, displayName: (service: string) => string): { shown: string[]; more: number } {
  const byName = [...addable].sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }));
  const picked = all ? [] : [...new Set(featured)].filter((s) => addable.includes(s));
  if (picked.length === 0) return { shown: byName, more: 0 };
  return { shown: picked, more: addable.length - picked.length };
}

export function shellQuote(word: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function reauthCommand(service: string, profile: string): string {
  return `agentio profile reauth ${shellQuote(service)} ${shellQuote(profile)}`;
}

export function addCommand(service: string): string {
  return `agentio ${shellQuote(service)} profile add`;
}

/**
 * The command that actually fixes a broken or credential-less profile. `agentio
 * profile reauth` only exists for plugins whose `profile.reauthenticate` is
 * defined; every other plugin is fixed by adding the profile again, by name.
 */
export function fixCommand(service: string, profile: string, canReauth: boolean): string {
  return canReauth ? reauthCommand(service, profile) : `agentio ${shellQuote(service)} profile add --profile ${shellQuote(profile)}`;
}

/** Lifts agentio's read-only block on a profile; run on the hub. */
export function allowWritesCommand(service: string, profile: string): string {
  return `agentio ${shellQuote(service)} profile update --profile ${shellQuote(profile)} --no-read-only`;
}

export function loginCommand(origin: string): string {
  return `agentio login ${shellQuote(origin)}`;
}

/** Installs agentio on macOS or Linux; the hub's install.md and Connect card both show it. */
export const INSTALL_COMMAND = 'curl -LsSf https://agentio.houlahop.com/install | sh';

/** The sentence an owner pastes into their agent: the hub's install.md does the rest. */
export function connectPrompt(origin: string): string {
  return `Set up agentio so you can use my profiles: follow ${origin}/install.md`;
}

// ---------- Data the page receives ----------

export type Status = 'ok' | 'invalid' | 'no-creds' | 'skipped' | 'testing';

/** One profile, flattened from `GET /ui/api/status?test=false`. */
export interface ProfileRow {
  service: string;
  profile: string;
  readOnly: boolean;
  status: Status;
  info?: string;
  error?: string;
  /** Who the profile signs in as, and where it lives; both public, from the plugin. */
  account?: string;
  url?: string;
}

/** A key as `GET /ui/api/keys` returns it: one machine. */
export interface Key {
  id: string;
  name: string;
  hint?: string;
  allowedProfiles: '*' | string[];
  readOnly: boolean;
  canManageProfiles: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

/** The body the key and approval routes accept. */
export interface KeyInput {
  name: string;
  allowedProfiles: '*' | string[];
  readOnly: boolean;
  canManageProfiles: boolean;
}

// ---------- Who can use what ----------

export const SILENT_DAYS = 30;

export const refOf = (p: { service: string; profile: string }): string => `${p.service}/${p.profile}`;

export function scopeIncludes(key: Pick<Key, 'allowedProfiles'>, ref: string): boolean {
  return key.allowedProfiles === '*' || key.allowedProfiles.includes(ref);
}

/** A machine writes only when neither it nor the profile is read-only. */
export function canWrite(key: Pick<Key, 'readOnly'>, profile: Pick<ProfileRow, 'readOnly'>): boolean {
  return !key.readOnly && !profile.readOnly;
}

export type Cell = 'Write' | 'Read' | 'None';

export function accessCell(key: Key, profile: ProfileRow): Cell {
  if (!scopeIncludes(key, refOf(profile))) return 'None';
  return canWrite(key, profile) ? 'Write' : 'Read';
}

/**
 * The key's profile list with `ref` added or removed. `*` becomes the list of
 * all existing profiles; references to deleted profiles are dropped, because
 * the daemon rejects them, and so is an empty list.
 */
export function toggleScope(key: Pick<Key, 'allowedProfiles'>, ref: string, allRefs: string[]): { allowedProfiles: string[] } | { error: string } {
  const current = (key.allowedProfiles === '*' ? allRefs : key.allowedProfiles).filter((r) => allRefs.includes(r));
  const next = current.includes(ref) ? current.filter((r) => r !== ref) : [...current, ref];
  const unique = [...new Set(next)].filter((r) => allRefs.includes(r)).sort();
  if (unique.length === 0) return { error: 'A machine needs at least one profile. To cut it off, revoke it from its page.' };
  return { allowedProfiles: unique };
}

export function machinesUsing(keys: Key[], profile: ProfileRow): Array<{ key: Key; canWrite: boolean }> {
  return keys
    .filter((k) => scopeIncludes(k, refOf(profile)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((k) => ({ key: k, canWrite: canWrite(k, profile) }));
}

/** What a machine can do through a profile, and why when it can only read. */
export function accessLevel(key: Pick<Key, 'readOnly'>, profile: Pick<ProfileRow, 'readOnly'>): { level: 'Write' | 'Read only'; reason: string } {
  if (key.readOnly && profile.readOnly) return { level: 'Read only', reason: 'because both the machine and the profile are read-only' };
  if (profile.readOnly) return { level: 'Read only', reason: 'because the profile is read-only' };
  if (key.readOnly) return { level: 'Read only', reason: 'because the machine is read-only' };
  return { level: 'Write', reason: '' };
}

/** The existing profiles a machine could read: after a revoke, the ones to reauthorise. */
export function reachableRefs(key: Pick<Key, 'allowedProfiles'>, allRefs: string[]): string[] {
  const refs = key.allowedProfiles === '*' ? allRefs : key.allowedProfiles.filter((r) => allRefs.includes(r));
  return [...refs].sort();
}

const lastActivity = (key: Key): number => Date.parse(key.lastUsedAt ?? key.createdAt);

export function isSilent(key: Key, now: number): boolean {
  const t = lastActivity(key);
  return !Number.isNaN(t) && now - t > SILENT_DAYS * DAY_MS;
}

export function seenToday(key: Key, now: number): boolean {
  if (!key.lastUsedAt) return false;
  const t = Date.parse(key.lastUsedAt);
  return !Number.isNaN(t) && now - t < DAY_MS;
}

/** When a machine was last seen, as a status. Never-used machines count from their creation. */
export function machineSeen(key: Key, now: number): StatusWord {
  const seen = key.lastUsedAt ? Date.parse(key.lastUsedAt) : NaN;
  if (isSilent(key, now)) {
    const days = Math.floor((now - lastActivity(key)) / DAY_MS);
    return { symbol: '!', word: Number.isNaN(seen) ? `Never used, created ${days} days ago` : `Silent for ${days} days`, tone: 'warn' };
  }
  if (Number.isNaN(seen)) return { symbol: '○', word: 'Never used', tone: 'neutral' };
  return { symbol: '✓', word: `Seen ${relativeTime(seen, now)}`, tone: 'ok' };
}

export function machineCanUse(key: Key, allRefs: string[]): string {
  if (key.allowedProfiles === '*') return `all ${plural(allRefs.length, 'profile')}`;
  const refs = reachableRefs(key, allRefs);
  if (refs.length === 0) return 'no profiles';
  if (refs.length === 1) return refs[0].replace('/', ' / ');
  return plural(refs.length, 'profile');
}

// ---------- Access presets (sign-in step 2, connect a machine) ----------

export type Preset =
  | { kind: 'read-all' }
  | { kind: 'same-as'; key: Key }
  | { kind: 'choose'; refs: string[]; readOnly: boolean };

export function presetInput(preset: Preset, name: string): KeyInput {
  switch (preset.kind) {
    case 'read-all':
      return { name, allowedProfiles: '*', readOnly: true, canManageProfiles: false };
    case 'same-as':
      return {
        name,
        allowedProfiles: preset.key.allowedProfiles === '*' ? '*' : [...preset.key.allowedProfiles],
        readOnly: preset.key.readOnly,
        canManageProfiles: preset.key.canManageProfiles,
      };
    case 'choose':
      if (preset.refs.length === 0) throw new Error('Choose at least one profile');
      return { name, allowedProfiles: [...new Set(preset.refs)].sort(), readOnly: preset.readOnly, canManageProfiles: false };
  }
}

// ---------- Access requests (sign-in with --scope) ----------

/** What a sign-in's scopes allow, as the owner reads it before approving. */
export function scopeLines(scopes: string[]): string[] {
  const lines = [
    scopes.includes('profiles:write')
      ? 'Use all your profiles, now and future, to read and write'
      : 'Use all your profiles, now and future, read-only',
  ];
  if (scopes.includes('profiles:manage')) lines.push('Add, reauth and delete profiles');
  return lines;
}

/** The machine key a sign-in revokes on approval. */
export function replacementLine(replaces: { name: string; createdAt: string }, now: number): string {
  return `This replaces “${replaces.name}” (created ${shortDate(Date.parse(replaces.createdAt), now)})`;
}

// ---------- Statuses ----------

/** A test the owner ran in this browser session. */
export interface TestResult {
  status: Status;
  detail: string;
  at: number;
}

/** A sign-in request waiting for the owner, as `GET /ui/api/authorize` lists it. */
export interface PendingSignIn {
  userCode: string;
  name: string;
  createdAt: string;
  expiresAt: string;
}

export type Tone = 'ok' | 'bad' | 'warn' | 'neutral';

/** A status as the page shows it: a symbol and words, coloured by tone, never by colour alone. */
export interface StatusWord {
  symbol: string;
  word: string;
  tone: Tone;
}

export function effectiveStatus(row: ProfileRow, results: ReadonlyMap<string, TestResult>): { status: Status; detail: string; at?: number } {
  const result = results.get(refOf(row));
  if (result) return { status: result.status, detail: result.detail, at: result.at };
  return { status: row.status, detail: row.error ?? row.info ?? '' };
}

export function statusWord(status: Status | string, session: boolean): StatusWord {
  switch (status) {
    case 'ok':
      return { symbol: '✓', word: session ? 'Connected' : 'Working', tone: 'ok' };
    case 'invalid':
      return { symbol: '✗', word: 'Failed', tone: 'bad' };
    case 'no-creds':
      return { symbol: '!', word: 'No credentials', tone: 'warn' };
    case 'testing':
      return { symbol: '⟳', word: 'Testing…', tone: 'neutral' };
    default:
      return { symbol: '○', word: 'Not tested', tone: 'neutral' };
  }
}

export function groupProfiles(rows: ProfileRow[], displayName: (service: string) => string): Array<{ service: string; name: string; rows: ProfileRow[] }> {
  const groups = new Map<string, ProfileRow[]>();
  for (const r of rows) groups.set(r.service, [...(groups.get(r.service) ?? []), r]);
  return [...groups.entries()]
    .map(([service, list]) => ({ service, name: displayName(service), rows: [...list].sort((a, b) => a.profile.localeCompare(b.profile)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const PROBLEM_RANK: Partial<Record<Status, number>> = { invalid: 0, 'no-creds': 1 };

/** Failed profiles first, then those with no credentials, then the rest; each keeps its order. */
export function problemsFirst(rows: ProfileRow[], results: ReadonlyMap<string, TestResult>): ProfileRow[] {
  const rank = (r: ProfileRow): number => PROBLEM_RANK[effectiveStatus(r, results).status] ?? 2;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/**
 * Whether a profile matches what the owner typed in the filter box: every
 * word, ignoring case, somewhere in its service id, the service's display
 * name, its name, its account or its link. Words are plain text, never patterns.
 */
/** A link as shown: https:// and a lone trailing slash dropped; http:// kept, so it reads as unencrypted. */
export function linkLabel(url: string): string {
  const bare = url.replace(/^https:\/\//i, '');
  return bare === url ? url : bare.replace(/^([^/?#]+)\/$/, '$1');
}

export function matchesFilter(row: ProfileRow, query: string, displayName: (service: string) => string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${row.service} ${displayName(row.service)} ${row.profile} ${row.info ?? ''} ${row.account ?? ''} ${row.url ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Whether a service matches the Add a profile filter: every word, ignoring case, in its id or display name. */
export function matchesService(service: string, query: string, displayName: (service: string) => string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${service} ${displayName(service)}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// ---------- Summary ----------

export interface HubSummary {
  profiles: number;
  working: number;
  failing: number;
  notTested: number;
  testedAt?: number;
  machines: number;
  seenToday: number;
  silent: number;
}

export function hubSummary(rows: ProfileRow[], keys: Key[], results: ReadonlyMap<string, TestResult>, now: number): HubSummary {
  const statuses = rows.map((r) => effectiveStatus(r, results));
  const times = rows.map((r) => results.get(refOf(r))?.at).filter((t): t is number => typeof t === 'number');
  const summary: HubSummary = {
    profiles: rows.length,
    working: statuses.filter((s) => s.status === 'ok').length,
    failing: statuses.filter((s) => s.status === 'invalid').length,
    notTested: statuses.filter((s) => s.status === 'skipped' || s.status === 'testing').length,
    machines: keys.length,
    seenToday: keys.filter((k) => seenToday(k, now)).length,
    silent: keys.filter((k) => isSilent(k, now)).length,
  };
  if (times.length) summary.testedAt = Math.max(...times);
  return summary;
}

// ---------- Overview ----------

const seenTime = (key: Key): number => {
  const t = key.lastUsedAt ? Date.parse(key.lastUsedAt) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};
const createdTime = (key: Key): number => {
  const t = Date.parse(key.createdAt);
  return Number.isNaN(t) ? -Infinity : t;
};

/** Machines by last seen, newest first; never-seen ones last, newest created first; then by name. */
export function recentlySeen(keys: Key[], limit = 5): Key[] {
  return [...keys]
    .sort((a, b) => (seenTime(b) - seenTime(a)) || (createdTime(b) - createdTime(a)) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}

/** What needs the owner: profiles that failed a test or have no credentials, machines silent for 30+ days. */
export interface Attention {
  failing: ProfileRow[];
  noCreds: ProfileRow[];
  silent: Key[];
}

export function attention(rows: ProfileRow[], keys: Key[], results: ReadonlyMap<string, TestResult>, now: number): Attention {
  return {
    failing: rows.filter((r) => effectiveStatus(r, results).status === 'invalid'),
    noCreds: rows.filter((r) => effectiveStatus(r, results).status === 'no-creds'),
    silent: keys.filter((k) => isSilent(k, now)),
  };
}

/** The attention banner's parts, each linked to where it can be fixed. Empty when all is well. */
export function attentionParts(a: Attention): Array<{ text: string; href: string }> {
  const parts: Array<{ text: string; href: string }> = [];
  const one = (n: number) => n === 1;
  if (a.failing.length) parts.push({ text: `${plural(a.failing.length, 'profile')} failed ${one(a.failing.length) ? 'its' : 'their'} test`, href: '#profiles' });
  if (a.noCreds.length) parts.push({ text: `${plural(a.noCreds.length, 'profile')} ${one(a.noCreds.length) ? 'has' : 'have'} no credentials`, href: '#profiles' });
  if (a.silent.length) parts.push({ text: `${plural(a.silent.length, 'machine')} silent for ${SILENT_DAYS}+ days`, href: '#machines' });
  return parts;
}

/** The Overview's status line. */
export function overviewStatus(s: HubSummary, now: number): StatusWord {
  if (s.profiles === 0) return { symbol: '○', word: 'No profiles yet', tone: 'neutral' };
  if (s.failing) return { symbol: '✗', word: `${s.failing} of ${s.profiles} failed`, tone: 'bad' };
  if (s.testedAt === undefined) return { symbol: '○', word: 'Not tested in this session', tone: 'neutral' };
  const when = `tested ${relativeTime(s.testedAt, now)}`;
  if (s.working === s.profiles) return { symbol: '✓', word: `All ${s.profiles} working · ${when}`, tone: 'ok' };
  return { symbol: '✓', word: `${s.working} of ${s.profiles} working · ${when}`, tone: 'ok' };
}
