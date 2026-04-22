import { describe, expect, test } from 'bun:test';
import { buildPlistDict, plistLabel } from './plist-builder';
import type { FrontmatterConfig } from '../../types/schedule';

const folder = '/Users/foo/proj';
const id = 'test';

function baseConfig(overrides: Partial<FrontmatterConfig>): FrontmatterConfig {
  return {
    schedule: { type: 'manual' },
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    sessionMode: 'new',
    enabled: true,
    ...overrides,
  };
}

describe('plistLabel', () => {
  test('uses folder hash + id', () => {
    const label = plistLabel(folder, id);
    expect(label).toMatch(/^me\.agentio\.schedule\.[0-9a-f]+-test$/);
  });
});

describe('buildPlistDict', () => {
  test('manual: no trigger keys', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'manual' } }));
    expect(dict.StartCalendarInterval).toBeUndefined();
    expect(dict.StartInterval).toBeUndefined();
    expect(dict.RunAtLoad).toBe(false);
  });

  test('daily: StartCalendarInterval dict', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'daily', hour: 21, minute: 30 } }));
    expect(dict.StartCalendarInterval).toEqual({ Hour: 21, Minute: 30 });
  });

  test('weekly: array of dicts, launchd weekday = our weekday (Sun=7 -> 0)', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'weekly', hour: 9, minute: 0, weekdays: [1, 5, 7] } }));
    expect(dict.StartCalendarInterval).toEqual([
      { Weekday: 1, Hour: 9, Minute: 0 },
      { Weekday: 5, Hour: 9, Minute: 0 },
      { Weekday: 0, Hour: 9, Minute: 0 },
    ]);
  });

  test('monthly: StartCalendarInterval with Day', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'monthly', day: 15, hour: 9, minute: 0 } }));
    expect(dict.StartCalendarInterval).toEqual({ Day: 15, Hour: 9, Minute: 0 });
  });

  test('interval: StartInterval in seconds', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'interval', intervalMinutes: 30 } }));
    expect(dict.StartInterval).toBe(1800);
  });

  test('ProgramArguments references the id and folder', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'manual' } }));
    expect(dict.ProgramArguments).toEqual([
      '/bin/zsh', '-lic',
      'agentio schedule run test --folder /Users/foo/proj --from-launchd',
    ]);
  });

  test('disabled: dict still built (caller decides to install or not)', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ enabled: false, schedule: { type: 'daily', hour: 9, minute: 0 } }));
    expect(dict.StartCalendarInterval).toBeDefined();
  });
});
