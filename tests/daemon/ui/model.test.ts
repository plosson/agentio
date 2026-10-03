import { describe, expect, test } from 'bun:test';
import {
  accessCell,
  accessLevel,
  problemsFirst,
  matchesService,
  addCommand,
  canWrite,
  clockTime,
  countdown,
  effectiveStatus,
  escapeHtml,
  fixCommand,
  groupProfiles,
  html,
  hubSummary,
  linkLabel,
  matchesFilter,
  allowWritesCommand,
  isSilent,
  listSummary,
  machineSeen,
  serviceNames,
  loginCommand,
  machineCanUse,
  machinesUsing,
  parseRoute,
  plural,
  presetInput,
  raw,
  reachableRefs,
  reauthCommand,
  refOf,
  relativeTime,
  routeHash,
  scopeIncludes,
  seenToday,
  shellQuote,
  shortDate,
  statusWord,
  tabOf,
  timeLeft,
  toggleScope,
  type Key,
  type ProfileRow,
  type TestResult,
} from '../../../src/daemon/ui/model';

const NOW = new Date(2026, 9, 1, 14, 5, 0).getTime(); // Oct 1 2026, 14:05 local time
const MIN = 60_000;
const DAY = 86_400_000;

describe('escaping', () => {
  test('escapeHtml neutralises every character that can open markup or an attribute', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(0)).toBe('0');
  });

  test('html escapes interpolations by default', () => {
    const name = '<script>alert(1)</script>';
    expect(html`<b>${name}</b>`.__html).toBe('<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>');
  });

  test('html keeps raw() and nested html as markup, joins arrays, drops empty values', () => {
    const items = ['a', '<b>'].map((x) => html`<li>${x}</li>`);
    expect(html`<ul>${items}</ul>`.__html).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>');
    expect(html`${raw('<hr>')}`.__html).toBe('<hr>');
    expect(html`[${null}${undefined}${false}${0}]`.__html).toBe('[0]');
  });

  test('an object that only looks like markup is escaped, not trusted', () => {
    expect(html`${{ toString: () => '<i>' }}`.__html).toBe('&lt;i&gt;');
  });
});

describe('routes', () => {
  test('known tabs and the default', () => {
    for (const view of ['machines', 'profiles', 'access', 'settings', 'add', 'connect', 'key'] as const) {
      expect(parseRoute(`#${view}`)).toEqual({ view });
    }
    // Profiles is the home page; old #overview bookmarks land there too.
    expect(parseRoute('#overview')).toEqual({ view: 'profiles' });
    expect(parseRoute('')).toEqual({ view: 'profiles' });
    expect(parseRoute('#')).toEqual({ view: 'profiles' });
    expect(parseRoute('#nonsense')).toEqual({ view: 'profiles' });
    expect(parseRoute('#machines=1')).toEqual({ view: 'profiles' });
  });

  test('the approval link the CLI prints keeps working', () => {
    expect(parseRoute('#authorize=KQ7M-2XWD')).toEqual({ view: 'authorize', code: 'KQ7M-2XWD' });
    expect(parseRoute('#authorize=')).toEqual({ view: 'profiles' });
  });

  test('ids and refs survive a round trip, whatever they contain', () => {
    const awkward = ['plain', 'with space', 'a=b', 'slash/inside', 'per%cent', 'hash#tag', 'é'];
    for (const name of awkward) {
      const machine = { view: 'machine', id: name } as const;
      expect(parseRoute(routeHash(machine))).toEqual(machine);
      const profile = { view: 'profile', ref: `gmail/${name}` } as const;
      expect(parseRoute(routeHash(profile))).toEqual(profile);
    }
  });

  test('a profile route needs service/name', () => {
    expect(parseRoute('#profile=gmail')).toEqual({ view: 'profiles' });
    expect(parseRoute('#profile=/work')).toEqual({ view: 'profiles' });
  });

  test('a mangled percent-encoding falls back to Profiles instead of throwing', () => {
    expect(parseRoute('#machine=%E0%A4%A')).toEqual({ view: 'profiles' });
  });

  test('tabOf highlights the parent tab', () => {
    expect(tabOf({ view: 'machine', id: 'x' })).toBe('machines');
    expect(tabOf({ view: 'access' })).toBe('machines');
    expect(tabOf({ view: 'connect' })).toBe('machines');
    expect(tabOf({ view: 'key' })).toBe('machines');
    expect(tabOf({ view: 'profile', ref: 'a/b' })).toBe('profiles');
    expect(tabOf({ view: 'add' })).toBe('profiles');
    expect(tabOf({ view: 'authorize', code: 'X' })).toBeNull();
    expect(tabOf({ view: 'settings' })).toBe('settings');
  });
});

describe('times', () => {
  test('relativeTime steps', () => {
    expect(relativeTime(undefined, NOW)).toBe('never');
    expect(relativeTime('', NOW)).toBe('never');
    expect(relativeTime('not a date', NOW)).toBe('never');
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW + 5 * MIN, NOW)).toBe('just now'); // clock skew never says "in the future"
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('5 min ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(relativeTime(NOW - DAY - 1000, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    expect(relativeTime(new Date(2026, 8, 2, 12).toISOString(), NOW)).toBe('Sep 2');
    expect(relativeTime(new Date(2025, 11, 24, 12).getTime(), NOW)).toBe('Dec 24, 2025');
  });

  test('shortDate and clockTime', () => {
    expect(shortDate(new Date(2026, 0, 5, 12).getTime(), NOW)).toBe('Jan 5');
    expect(clockTime(NOW)).toBe('14:05');
    expect(clockTime(new Date(2026, 9, 1, 9, 7).getTime())).toBe('09:07');
  });

  test('timeLeft', () => {
    expect(timeLeft(new Date(NOW + 8 * MIN).toISOString(), NOW)).toBe('ends in 8 min');
    expect(timeLeft(new Date(NOW + 30_000).toISOString(), NOW)).toBe('ends in less than a minute');
    expect(timeLeft(new Date(NOW - 1).toISOString(), NOW)).toBe('ended');
    expect(timeLeft('garbage', NOW)).toBe('ended');
  });
});

describe('commands', () => {
  test('safe words are left alone', () => {
    expect(shellQuote('plosson@gmail.com')).toBe('plosson@gmail.com');
    expect(shellQuote('hex-rays.atlassian.net')).toBe('hex-rays.atlassian.net');
  });

  test('anything else is single-quoted, including quotes and the empty string', () => {
    expect(shellQuote('my work')).toBe("'my work'");
    expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
    expect(shellQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'");
    expect(shellQuote('')).toBe("''");
  });

  test('the commands the screens show', () => {
    expect(reauthCommand('gmail', 'work')).toBe('agentio profile reauth gmail work');
    expect(reauthCommand('gmail', 'my work')).toBe("agentio profile reauth gmail 'my work'");
    expect(addCommand('jira')).toBe('agentio jira profile add');
    expect(loginCommand('https://agentio.chuut.com')).toBe('agentio login https://agentio.chuut.com');
  });

  test('fixCommand reauths where the plugin supports it, else adds the profile again by name', () => {
    expect(fixCommand('gmail', 'work', true)).toBe('agentio profile reauth gmail work');
    expect(fixCommand('discourse', 'bot', false)).toBe('agentio discourse profile add --profile bot');
    expect(fixCommand('notes', 'my work', false)).toBe("agentio notes profile add --profile 'my work'");
  });

  test('plural', () => {
    expect(plural(0, 'profile')).toBe('0 profiles');
    expect(plural(1, 'profile')).toBe('1 profile');
    expect(plural(11, 'machine')).toBe('11 machines');
  });
});

const row = (service: string, profile: string, extra: Partial<ProfileRow> = {}): ProfileRow =>
  ({ service, profile, readOnly: false, status: 'skipped', ...extra });
const key = (name: string, extra: Partial<Key> = {}): Key =>
  ({ id: `id-${name}`, name, allowedProfiles: '*', readOnly: false, canManageProfiles: false, createdAt: new Date(NOW - 10 * DAY).toISOString(), ...extra });

const ALL = ['gmail/perso', 'gmail/work', 'jira/hex-rays'];

describe('who can use what', () => {
  test('a cell says Write only when neither the machine nor the profile is read-only', () => {
    const p = row('gmail', 'work');
    expect(accessCell(key('mac'), p)).toBe('Write');
    expect(accessCell(key('mac', { readOnly: true }), p)).toBe('Read');
    expect(accessCell(key('mac'), row('gmail', 'work', { readOnly: true }))).toBe('Read');
    expect(accessCell(key('ci', { allowedProfiles: ['jira/hex-rays'] }), p)).toBe('None');
    expect(canWrite({ readOnly: false }, { readOnly: false })).toBe(true);
  });

  test('refs are service/name, and * includes everything', () => {
    expect(refOf({ service: 'gmail', profile: 'my work' })).toBe('gmail/my work');
    expect(scopeIncludes({ allowedProfiles: '*' }, 'anything/x')).toBe(true);
    expect(scopeIncludes({ allowedProfiles: ['gmail/work'] }, 'gmail/perso')).toBe(false);
  });

  test('toggleScope adds and removes, sorted, without duplicates', () => {
    expect(toggleScope({ allowedProfiles: ['jira/hex-rays'] }, 'gmail/work', ALL)).toEqual({ allowedProfiles: ['gmail/work', 'jira/hex-rays'] });
    expect(toggleScope({ allowedProfiles: ['gmail/work', 'jira/hex-rays'] }, 'gmail/work', ALL)).toEqual({ allowedProfiles: ['jira/hex-rays'] });
  });

  test('a machine on every profile loses one: the explicit list of all the others', () => {
    expect(toggleScope({ allowedProfiles: '*' }, 'gmail/work', ALL)).toEqual({ allowedProfiles: ['gmail/perso', 'jira/hex-rays'] });
  });

  test('references to deleted profiles are dropped, since the daemon rejects them', () => {
    expect(toggleScope({ allowedProfiles: ['gone/old', 'gmail/work'] }, 'jira/hex-rays', ALL)).toEqual({ allowedProfiles: ['gmail/work', 'jira/hex-rays'] });
  });

  test('removing the last profile is refused: revoke the machine instead', () => {
    const result = toggleScope({ allowedProfiles: ['gmail/work'] }, 'gmail/work', ALL);
    expect(result).toEqual({ error: 'A machine needs at least one profile. To cut it off, revoke it from its page.' });
    const stale = toggleScope({ allowedProfiles: ['gone/old', 'gmail/work'] }, 'gmail/work', ALL);
    expect('error' in stale).toBe(true);
  });

  test('toggling a ref that is not in allRefs never returns it', () => {
    expect(toggleScope({ allowedProfiles: ['gmail/work'] }, 'gone/old', ALL)).toEqual({ allowedProfiles: ['gmail/work'] });
    expect(toggleScope({ allowedProfiles: ['gone/old'] }, 'gone/new', ALL)).toEqual({ error: 'A machine needs at least one profile. To cut it off, revoke it from its page.' });
  });

  test('machinesUsing lists who can reach a profile and whether they can write, by name', () => {
    const keys = [key('old-vps', { readOnly: true }), key('ci', { allowedProfiles: ['jira/hex-rays'] }), key('macbook')];
    expect(machinesUsing(keys, row('gmail', 'work')).map((m) => [m.key.name, m.canWrite])).toEqual([['macbook', true], ['old-vps', false]]);
    expect(machinesUsing([], row('gmail', 'work'))).toEqual([]);
  });

  test('reachableRefs is what a revoked machine could read', () => {
    expect(reachableRefs({ allowedProfiles: '*' }, ALL)).toEqual(ALL);
    expect(reachableRefs({ allowedProfiles: ['jira/hex-rays', 'gone/old'] }, ALL)).toEqual(['jira/hex-rays']);
  });

  test('machineCanUse wording', () => {
    expect(machineCanUse(key('a'), ALL)).toBe('all 3 profiles');
    expect(machineCanUse(key('a'), ['gmail/work'])).toBe('all 1 profile');
    expect(machineCanUse(key('a', { allowedProfiles: ['jira/hex-rays'] }), ALL)).toBe('jira / hex-rays');
    expect(machineCanUse(key('a', { allowedProfiles: ['gmail/work', 'jira/hex-rays'] }), ALL)).toBe('2 profiles');
    expect(machineCanUse(key('a', { allowedProfiles: ['gone/old'] }), ALL)).toBe('no profiles');
  });

  test('silent after 30 days without use; never used counts from creation', () => {
    expect(isSilent(key('a', { lastUsedAt: new Date(NOW - 31 * DAY).toISOString() }), NOW)).toBe(true);
    expect(isSilent(key('a', { lastUsedAt: new Date(NOW - 29 * DAY).toISOString() }), NOW)).toBe(false);
    expect(isSilent(key('a', { createdAt: new Date(NOW - 40 * DAY).toISOString() }), NOW)).toBe(true);
    expect(isSilent(key('a', { createdAt: new Date(NOW - 2 * DAY).toISOString() }), NOW)).toBe(false);
    expect(isSilent(key('a', { createdAt: 'garbage' }), NOW)).toBe(false);
    expect(seenToday(key('a', { lastUsedAt: new Date(NOW - 3_600_000).toISOString() }), NOW)).toBe(true);
    expect(seenToday(key('a'), NOW)).toBe(false);
  });
});

describe('access presets', () => {
  test('read everything is the read-only default', () => {
    expect(presetInput({ kind: 'read-all' }, 'build-box')).toEqual({ name: 'build-box', allowedProfiles: '*', readOnly: true, canManageProfiles: false });
  });

  test('same as copies the other machine, without sharing its array', () => {
    const other = key('macbook', { allowedProfiles: ['gmail/work'], canManageProfiles: true });
    const input = presetInput({ kind: 'same-as', key: other }, 'build-box');
    expect(input).toEqual({ name: 'build-box', allowedProfiles: ['gmail/work'], readOnly: false, canManageProfiles: true });
    (input.allowedProfiles as string[]).push('x/y');
    expect(other.allowedProfiles).toEqual(['gmail/work']);
  });

  test('choose needs at least one profile and never grants profile management', () => {
    expect(presetInput({ kind: 'choose', refs: ['jira/hex-rays', 'gmail/work', 'gmail/work'], readOnly: true }, 'ci'))
      .toEqual({ name: 'ci', allowedProfiles: ['gmail/work', 'jira/hex-rays'], readOnly: true, canManageProfiles: false });
    expect(() => presetInput({ kind: 'choose', refs: [], readOnly: true }, 'ci')).toThrow('Choose at least one profile');
  });
});

describe('statuses', () => {
  test('a test result taken in this session wins over the page load', () => {
    const p = row('gmail', 'work', { status: 'skipped' });
    const results = new Map<string, TestResult>([['gmail/work', { status: 'invalid', detail: 'invalid_grant', at: NOW }]]);
    expect(effectiveStatus(p, results)).toEqual({ status: 'invalid', detail: 'invalid_grant', at: NOW });
    expect(effectiveStatus(p, new Map())).toEqual({ status: 'skipped', detail: '' });
    expect(effectiveStatus(row('whatsapp', 'work', { status: 'ok', info: '+32 4…' }), new Map())).toEqual({ status: 'ok', detail: '+32 4…' });
    expect(effectiveStatus(row('x', 'y', { status: 'invalid', error: 'boom', info: 'acct' }), new Map()).detail).toBe('boom');
  });

  test('status words: a symbol and a word for every status, never colour alone', () => {
    expect(statusWord('ok', false)).toEqual({ symbol: '✓', word: 'Working', tone: 'ok' });
    expect(statusWord('ok', true)).toEqual({ symbol: '✓', word: 'Connected', tone: 'ok' });
    expect(statusWord('invalid', false)).toEqual({ symbol: '✗', word: 'Failed', tone: 'bad' });
    expect(statusWord('no-creds', false)).toEqual({ symbol: '!', word: 'No credentials', tone: 'warn' });
    expect(statusWord('testing', false)).toEqual({ symbol: '⟳', word: 'Testing…', tone: 'neutral' });
    expect(statusWord('skipped', false)).toEqual({ symbol: '○', word: 'Not tested', tone: 'neutral' });
  });

  test('a status the page does not know reads as not tested, not as working', () => {
    expect(statusWord('exploded', false)).toEqual({ symbol: '○', word: 'Not tested', tone: 'neutral' });
    expect(statusWord('', true)).toEqual({ symbol: '○', word: 'Not tested', tone: 'neutral' });
  });

  test('groups by display name, profiles by name', () => {
    const names: Record<string, string> = { gmail: 'Gmail', jira: 'Jira', notes: 'Apple Notes' };
    const groups = groupProfiles([row('jira', 'hex-rays'), row('gmail', 'work'), row('notes', 'macmini'), row('gmail', 'perso')], (s) => names[s] ?? s);
    expect(groups.map((g) => [g.name, g.rows.map((r) => r.profile)])).toEqual([
      ['Apple Notes', ['macmini']], ['Gmail', ['perso', 'work']], ['Jira', ['hex-rays']],
    ]);
    expect(groupProfiles([], (s) => s)).toEqual([]);
  });
});

describe('hub summary', () => {
  test('hub summary', () => {
    const rows = [row('gmail', 'work'), row('gmail', 'perso'), row('jira', 'hex-rays')];
    const results = new Map<string, TestResult>([
      ['gmail/work', { status: 'invalid', detail: 'x', at: NOW - 5 * MIN }],
      ['gmail/perso', { status: 'ok', detail: '', at: NOW - 2 * MIN }],
      ['deleted/one', { status: 'ok', detail: '', at: NOW }],
    ]);
    const keys = [
      key('macbook', { lastUsedAt: new Date(NOW - MIN).toISOString() }),
      key('old-vps', { lastUsedAt: new Date(NOW - 41 * DAY).toISOString() }),
    ];
    expect(hubSummary(rows, keys, results, NOW)).toEqual({
      profiles: 3, working: 1, failing: 1, notTested: 1, testedAt: NOW - 2 * MIN, machines: 2, seenToday: 1, silent: 1,
    });
    expect(hubSummary([], [], new Map(), NOW)).toEqual({ profiles: 0, working: 0, failing: 0, notTested: 0, machines: 0, seenToday: 0, silent: 0 });
  });
});

describe('filtering profiles', () => {
  const names: Record<string, string> = { gmail: 'Gmail', gcal: 'Google Calendar', notes: 'Apple Notes' };
  const name = (s: string) => names[s] ?? s;
  const work = row('gmail', 'work', { info: 'palosson@hex-rays.com' });

  test('an empty or blank filter keeps everything', () => {
    expect(matchesFilter(work, '', name)).toBe(true);
    expect(matchesFilter(work, '   ', name)).toBe(true);
  });

  test('matches the profile name, the service id, its display name or the account, ignoring case', () => {
    expect(matchesFilter(work, 'WORK', name)).toBe(true);
    expect(matchesFilter(work, 'gmail', name)).toBe(true);
    expect(matchesFilter(row('gcal', 'perso'), 'google', name)).toBe(true);
    expect(matchesFilter(work, 'hex-rays', name)).toBe(true);
    expect(matchesFilter(work, 'perso', name)).toBe(false);
  });

  test('every word must match, in any order', () => {
    expect(matchesFilter(work, 'work gmail', name)).toBe(true);
    expect(matchesFilter(work, 'gmail  work ', name)).toBe(true);
    expect(matchesFilter(work, 'gmail perso', name)).toBe(false);
  });

  test('text is matched literally, not as a pattern', () => {
    expect(matchesFilter(row('sql', 'a.b'), 'a.b', name)).toBe(true);
    expect(matchesFilter(row('sql', 'axb'), 'a.b', name)).toBe(false);
    expect(matchesFilter(row('sql', 'x'), '(', name)).toBe(false);
  });

  test('matches the account and the link the hub shows for the profile', () => {
    const notes = row('notes', 'mac', { account: 'me@icloud.com', url: 'https://mac.tail1.ts.net' });
    expect(matchesFilter(notes, 'icloud', name)).toBe(true);
    expect(matchesFilter(notes, 'tail1', name)).toBe(true);
    expect(matchesFilter(row('notes', 'mac'), 'undefined', name)).toBe(false);
  });

  test('a row with no account still filters by its other fields', () => {
    expect(matchesFilter(row('notes', 'macmini'), 'apple mac', name)).toBe(true);
  });
});

describe('read-only', () => {
  test('the command that lifts it names the profile, quoted when needed', () => {
    expect(allowWritesCommand('gmail', 'work')).toBe('agentio gmail profile update --profile work --no-read-only');
    expect(allowWritesCommand('gmail', 'my work')).toBe("agentio gmail profile update --profile 'my work' --no-read-only");
  });
});

describe('link labels', () => {
  test('drop the scheme and a bare trailing slash, keep the rest', () => {
    expect(linkLabel('https://mail.google.com')).toBe('mail.google.com');
    expect(linkLabel('https://mail.google.com/')).toBe('mail.google.com');
    expect(linkLabel('https://github.com/plosson')).toBe('github.com/plosson');
    expect(linkLabel('https://x.example/a/?q=1#f')).toBe('x.example/a/?q=1#f');
  });

  test('plain http stays visible, so an unencrypted link is not mistaken for a safe one', () => {
    expect(linkLabel('http://mac.local:8080')).toBe('http://mac.local:8080');
  });

  test('anything that is not an http(s) URL is shown as is, never altered', () => {
    expect(linkLabel('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(linkLabel('')).toBe('');
    expect(linkLabel('HTTPS://Upper.example')).toBe('Upper.example');
  });
});

describe('countdown', () => {
  const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

  test('minutes and seconds, padded', () => {
    expect(countdown(at(252), NOW)).toBe('4:12 left');
    expect(countdown(at(60), NOW)).toBe('1:00 left');
    expect(countdown(at(9), NOW)).toBe('0:09 left');
  });

  test('hours when there are any', () => {
    expect(countdown(at(3725), NOW)).toBe('1:02:05 left');
  });

  test('a fraction of a second left still shows as a second, not as ended', () => {
    expect(countdown(new Date(NOW + 400).toISOString(), NOW)).toBe('0:01 left');
  });

  test('at or past the end, or for a date that cannot be read, it has ended', () => {
    expect(countdown(at(0), NOW)).toBe('ended');
    expect(countdown(at(-30), NOW)).toBe('ended');
    expect(countdown('not a date', NOW)).toBe('ended');
    expect(countdown('', NOW)).toBe('ended');
  });
});

describe('access level', () => {
  test('write only when neither side is read-only; otherwise read only, with the reason', () => {
    expect(accessLevel({ readOnly: false }, { readOnly: false })).toEqual({ level: 'Write', reason: '' });
    expect(accessLevel({ readOnly: false }, { readOnly: true })).toEqual({ level: 'Read only', reason: 'because the profile is read-only' });
    expect(accessLevel({ readOnly: true }, { readOnly: false })).toEqual({ level: 'Read only', reason: 'because the machine is read-only' });
    expect(accessLevel({ readOnly: true }, { readOnly: true })).toEqual({ level: 'Read only', reason: 'because both the machine and the profile are read-only' });
  });

  test('agrees with canWrite for every combination', () => {
    for (const k of [true, false]) for (const p of [true, false]) {
      expect(accessLevel({ readOnly: k }, { readOnly: p }).level === 'Write').toBe(canWrite({ readOnly: k }, { readOnly: p }));
    }
  });
});

describe('problems first', () => {
  test('failed, then no credentials, then the rest, each in the order given', () => {
    const rows = [row('gmail', 'a'), row('gmail', 'b', { status: 'no-creds' }), row('gmail', 'c'), row('gmail', 'd')];
    const results = new Map<string, TestResult>([['gmail/d', { status: 'invalid', detail: 'x', at: NOW }]]);
    expect(problemsFirst(rows, results).map((r) => r.profile)).toEqual(['d', 'b', 'a', 'c']);
  });

  test('does not touch its input, and copes with nothing', () => {
    const rows = [row('gmail', 'a'), row('gmail', 'b', { status: 'invalid' })];
    problemsFirst(rows, new Map());
    expect(rows.map((r) => r.profile)).toEqual(['a', 'b']);
    expect(problemsFirst([], new Map())).toEqual([]);
  });

  test('a test that passed in this session lifts a profile the page loaded as failed', () => {
    const rows = [row('gmail', 'a'), row('gmail', 'b', { status: 'invalid' })];
    const results = new Map<string, TestResult>([['gmail/b', { status: 'ok', detail: '', at: NOW }]]);
    expect(problemsFirst(rows, results).map((r) => r.profile)).toEqual(['a', 'b']);
  });
});

describe('matching services', () => {
  const names: Record<string, string> = { gcal: 'Google Calendar', gmail: 'Gmail' };
  const name = (s: string) => names[s] ?? s;

  test('every word, ignoring case, in the id or the display name', () => {
    expect(matchesService('gcal', 'google cal', name)).toBe(true);
    expect(matchesService('gcal', 'GCAL', name)).toBe(true);
    expect(matchesService('gmail', 'google', name)).toBe(false);
    expect(matchesService('gmail', '', name)).toBe(true);
    expect(matchesService('gmail', '   ', name)).toBe(true);
  });

  test('typed text is never a pattern', () => {
    expect(matchesService('gmail', '.*', name)).toBe(false);
    expect(matchesService('gmail', '(', name)).toBe(false);
  });
});

describe('summaries', () => {
  test('listSummary: up to three, then "N more"; never "1 more"', () => {
    expect(listSummary([])).toBe('');
    expect(listSummary(['Gmail'])).toBe('Gmail');
    expect(listSummary(['A', 'B', 'C'])).toBe('A · B · C');
    expect(listSummary(['A', 'B', 'C', 'D'])).toBe('A · B · C · D');
    expect(listSummary(['A', 'B', 'C', 'D', 'E'])).toBe('A · B · C · 2 more');
    expect(listSummary(Array.from({ length: 40 }, (_, i) => `S${i}`))).toBe('S0 · S1 · S2 · 37 more');
    expect(listSummary(['A', 'B', 'C'], 1)).toBe('A · 2 more');
  });

  test('serviceNames: display names, once each, sorted; unknown services fall back to their id', () => {
    const names: Record<string, string> = { gmail: 'Gmail', jira: 'Jira' };
    const name = (s: string) => names[s] ?? s;
    expect(serviceNames([{ service: 'jira' }, { service: 'gmail' }, { service: 'gmail' }, { service: 'zzz-new' }], name)).toEqual(['Gmail', 'Jira', 'zzz-new']);
    expect(serviceNames([], name)).toEqual([]);
  });

  test('serviceNames never shows "undefined" for a service the page has no name for', () => {
    expect(serviceNames([{ service: 'mystery' }], () => undefined as unknown as string)).toEqual(['mystery']);
  });
});

describe('when a machine was last seen', () => {
  test('seen recently: ✓ with the relative time', () => {
    expect(machineSeen(key('a', { lastUsedAt: new Date(NOW - 2 * MIN).toISOString() }), NOW)).toEqual({ symbol: '✓', word: 'Seen 2 min ago', tone: 'ok' });
  });

  test('a clock ahead of ours reads as just now, not as the future', () => {
    expect(machineSeen(key('a', { lastUsedAt: new Date(NOW + 10 * MIN).toISOString() }), NOW).word).toBe('Seen just now');
  });

  test('silent for 30+ days: ! with the number of days', () => {
    expect(machineSeen(key('a', { lastUsedAt: new Date(NOW - 34 * DAY).toISOString() }), NOW)).toEqual({ symbol: '!', word: 'Silent for 34 days', tone: 'warn' });
  });

  test('never used: ○ while new, ! once it is 30+ days old', () => {
    expect(machineSeen(key('a', { createdAt: new Date(NOW - 2 * DAY).toISOString() }), NOW)).toEqual({ symbol: '○', word: 'Never used', tone: 'neutral' });
    expect(machineSeen(key('a', { createdAt: new Date(NOW - 40 * DAY).toISOString() }), NOW)).toEqual({ symbol: '!', word: 'Never used, created 40 days ago', tone: 'warn' });
  });

  test('a last-seen date that cannot be read counts as never used', () => {
    expect(machineSeen(key('a', { lastUsedAt: 'garbage', createdAt: new Date(NOW - DAY).toISOString() }), NOW)).toEqual({ symbol: '○', word: 'Never used', tone: 'neutral' });
  });
});
