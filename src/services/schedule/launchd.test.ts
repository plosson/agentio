import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import plist from 'plist';
import { enumerateInstalledSchedules } from './launchd';

describe('enumerateInstalledSchedules', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentio-launchd-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writePlist(label: string, dict: Record<string, unknown>): void {
    writeFileSync(join(dir, `${label}.plist`), plist.build(dict as unknown as plist.PlistObject));
  }

  test('skips non-agentio plists', () => {
    writePlist('com.other.tool', { Label: 'com.other.tool', ProgramArguments: ['x'] });
    const result = enumerateInstalledSchedules(dir);
    expect(result).toEqual([]);
  });

  test('extracts id and folder from ProgramArguments', () => {
    writePlist('me.agentio.schedule.abc-mytask', {
      Label: 'me.agentio.schedule.abc-mytask',
      ProgramArguments: [
        '/bin/zsh', '-lic',
        'agentio schedule run mytask --folder /Users/x/proj -q',
      ],
    });
    const result = enumerateInstalledSchedules(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      label: 'me.agentio.schedule.abc-mytask',
      plistPath: join(dir, 'me.agentio.schedule.abc-mytask.plist'),
      id: 'mytask',
      folder: '/Users/x/proj',
    });
  });

  test('skips malformed agentio plists', () => {
    writePlist('me.agentio.schedule.bad', { Label: 'me.agentio.schedule.bad', ProgramArguments: ['nope'] });
    expect(enumerateInstalledSchedules(dir)).toEqual([]);
  });
});
