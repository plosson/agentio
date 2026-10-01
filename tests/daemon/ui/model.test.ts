import { describe, expect, test } from 'bun:test';
import {
  accessCell,
  addCommand,
  canWrite,
  clockTime,
  escapeHtml,
  html,
  isSilent,
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
  tabOf,
  timeLeft,
  toggleScope,
  type Key,
  type ProfileRow,
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
    for (const view of ['overview', 'machines', 'profiles', 'access', 'settings', 'add'] as const) {
      expect(parseRoute(`#${view}`)).toEqual({ view });
    }
    expect(parseRoute('')).toEqual({ view: 'overview' });
    expect(parseRoute('#')).toEqual({ view: 'overview' });
    expect(parseRoute('#nonsense')).toEqual({ view: 'overview' });
    expect(parseRoute('#machines=1')).toEqual({ view: 'overview' });
  });

  test('the approval link the CLI prints keeps working', () => {
    expect(parseRoute('#authorize=KQ7M-2XWD')).toEqual({ view: 'authorize', code: 'KQ7M-2XWD' });
    expect(parseRoute('#authorize=')).toEqual({ view: 'overview' });
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
    expect(parseRoute('#profile=gmail')).toEqual({ view: 'overview' });
    expect(parseRoute('#profile=/work')).toEqual({ view: 'overview' });
  });

  test('a mangled percent-encoding falls back to the overview instead of throwing', () => {
    expect(parseRoute('#machine=%E0%A4%A')).toEqual({ view: 'overview' });
  });

  test('tabOf highlights the parent tab', () => {
    expect(tabOf({ view: 'machine', id: 'x' })).toBe('machines');
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
  test('a cell is W only when neither the machine nor the profile is read-only', () => {
    const p = row('gmail', 'work');
    expect(accessCell(key('mac'), p)).toBe('W');
    expect(accessCell(key('mac', { readOnly: true }), p)).toBe('R');
    expect(accessCell(key('mac'), row('gmail', 'work', { readOnly: true }))).toBe('R');
    expect(accessCell(key('ci', { allowedProfiles: ['jira/hex-rays'] }), p)).toBe('·');
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
