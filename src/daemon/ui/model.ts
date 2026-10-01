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

/**
 * The command that actually fixes a broken or credential-less profile. `agentio
 * profile reauth` only exists for plugins whose `profile.reauthenticate` is
 * defined; every other plugin is fixed by adding the profile again, by name.
 */
export function fixCommand(service: string, profile: string, canReauth: boolean): string {
  return canReauth ? reauthCommand(service, profile) : `agentio ${shellQuote(service)} profile add --profile ${shellQuote(profile)}`;
}

export function loginCommand(origin: string): string {
  return `agentio login ${shellQuote(origin)}`;
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

export type Cell = 'W' | 'R' | '·';

export function accessCell(key: Key, profile: ProfileRow): Cell {
  if (!scopeIncludes(key, refOf(profile))) return '·';
  return canWrite(key, profile) ? 'W' : 'R';
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

export type Tone = 'ok' | 'red' | 'warn' | 'neutral';

export function effectiveStatus(row: ProfileRow, results: ReadonlyMap<string, TestResult>): { status: Status; detail: string; at?: number } {
  const result = results.get(refOf(row));
  if (result) return { status: result.status, detail: result.detail, at: result.at };
  return { status: row.status, detail: row.error ?? row.info ?? '' };
}

export function statusPill(status: Status, session: boolean): { label: string; tone: Tone } {
  switch (status) {
    case 'ok':
      return { label: session ? 'connected' : 'working', tone: 'ok' };
    case 'invalid':
      return { label: 'not working', tone: 'red' };
    case 'no-creds':
      return { label: 'no credentials', tone: 'warn' };
    case 'testing':
      return { label: 'testing…', tone: 'neutral' };
    default:
      return { label: 'not tested', tone: 'neutral' };
  }
}

export function groupProfiles(rows: ProfileRow[], displayName: (service: string) => string): Array<{ service: string; name: string; rows: ProfileRow[] }> {
  const groups = new Map<string, ProfileRow[]>();
  for (const r of rows) groups.set(r.service, [...(groups.get(r.service) ?? []), r]);
  return [...groups.entries()]
    .map(([service, list]) => ({ service, name: displayName(service), rows: [...list].sort((a, b) => a.profile.localeCompare(b.profile)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a profile matches what the owner typed in the filter box: every
 * word, ignoring case, somewhere in its service id, the service's display
 * name, its name or its account. Words are plain text, never patterns.
 */
export function matchesFilter(row: ProfileRow, query: string, displayName: (service: string) => string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${row.service} ${displayName(row.service)} ${row.profile} ${row.info ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// ---------- What needs the owner ----------

export type NeedItem =
  | { kind: 'sign-in'; request: PendingSignIn }
  | { kind: 'profile'; row: ProfileRow; detail: string; at?: number; usedBy: number };

/** Sign-ins waiting, oldest first, then profiles known not to work. Nothing is tested here. */
export function needsYou(pending: PendingSignIn[], rows: ProfileRow[], results: ReadonlyMap<string, TestResult>, keys: Key[]): NeedItem[] {
  const signIns: NeedItem[] = [...pending]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((request) => ({ kind: 'sign-in', request }));
  const broken: NeedItem[] = rows
    .map((row) => ({ row, s: effectiveStatus(row, results) }))
    .filter(({ s }) => s.status === 'invalid')
    .sort((a, b) => refOf(a.row).localeCompare(refOf(b.row)))
    .map(({ row, s }) => ({ kind: 'profile', row, detail: s.detail, at: s.at, usedBy: keys.filter((k) => scopeIncludes(k, refOf(row))).length }));
  return [...signIns, ...broken];
}

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
