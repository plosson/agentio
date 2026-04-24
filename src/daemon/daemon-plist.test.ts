import { describe, expect, test } from 'bun:test';
import { buildDaemonPlist } from './daemon-plist';

describe('buildDaemonPlist', () => {
  test('includes Label, ProgramArguments, RunAtLoad, KeepAlive', () => {
    const dict = buildDaemonPlist({
      binaryPath: '/usr/local/bin/agentio',
      logPath: '/Users/me/.config/agentio/daemon.log',
      home: '/Users/me',
      extraPath: '/opt/homebrew/bin',
    });
    expect(dict.Label).toBe('me.agentio.daemon');
    expect(dict.ProgramArguments).toEqual([
      '/usr/local/bin/agentio',
      'daemon',
      'start',
      '--foreground',
    ]);
    expect(dict.RunAtLoad).toBe(true);
    expect(dict.KeepAlive).toBe(true);
    expect(dict.StandardOutPath).toBe('/Users/me/.config/agentio/daemon.log');
    expect(dict.StandardErrorPath).toBe('/Users/me/.config/agentio/daemon.log');
    expect(dict.WorkingDirectory).toBe('/Users/me');
    expect((dict.EnvironmentVariables as Record<string, string>).HOME).toBe('/Users/me');
    expect((dict.EnvironmentVariables as Record<string, string>).PATH).toContain('/opt/homebrew/bin');
  });
});
