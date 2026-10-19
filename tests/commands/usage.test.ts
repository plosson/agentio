import { afterEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { closeUsageStore, DAY_MS, recordUsage } from '../../src/usage/store';
import { formatUsage, parseBy, parseSince } from '../../src/commands/usage';

const env = withTempVault('agentio-usage-cmd-', () => ({}));
afterEach(() => closeUsageStore());

async function cli(args: string[]) {
  const vars: Record<string, string> = { ...(process.env as Record<string, string>), ...env.env() };
  delete vars.AGENTIO_PASSPHRASE;
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], { stdout: 'pipe', stderr: 'pipe', env: vars });
  const exitCode = await proc.exited;
  return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

describe('parseSince', () => {
  test('accepts 1d to 90d', () => {
    expect(parseSince('1d')).toBe(DAY_MS);
    expect(parseSince('90d')).toBe(90 * DAY_MS);
  });

  test.each(['0d', '91d', '7', 'd', '-3d', '7w', '1e3d', ' 7d; rm -rf', '9999999999999d'])('refuses %p', (value) => {
    expect(() => parseSince(value)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });
});

describe('parseBy', () => {
  test.each(['commands', 'COMMAND', '', 'command; DROP TABLE events', '__proto__', 'toString'])('refuses %p', (value) => {
    expect(() => parseBy(value)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });
});

describe('formatUsage', () => {
  test('the time column says it is UTC', () => {
    expect(formatUsage([{ group: 'a', count: 1, failures: 0, lastSeen: 0 }], 'command').split('\n')[0]).toContain('LAST SEEN (UTC)');
  });

  test('a small failure rate reads <1%, a real zero stays 0%', () => {
    const [, small, none, half] = formatUsage([
      { group: 'small', count: 1000, failures: 1, lastSeen: 0 },
      { group: 'none', count: 1000, failures: 0, lastSeen: 0 },
      { group: 'half', count: 2, failures: 1, lastSeen: 0 },
    ], 'command').split('\n');
    expect(small).toContain('<1%');
    expect(none).toContain(' 0%');
    expect(none).not.toContain('<1%');
    expect(half).toContain('50%');
  });

  test('a group name with a newline cannot break the table', () => {
    const out = formatUsage([{ group: 'a\nb', count: 1, failures: 0, lastSeen: 0 }], 'command');
    expect(out.split('\n').length).toBe(2);
  });
});

describe('agentio usage', () => {
  test('an empty store says so and exits 0', async () => {
    const res = await cli(['usage']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('No usage recorded yet');
  });

  test('reads the store without the passphrase, grouped and as JSON', async () => {
    await recordUsage({ service: 'gmail', profile: 'work', command: 'gmail list', host: 'box', keyId: 'local', keyName: 'local', outcome: 'ok', version: '3.23.1' });
    await recordUsage({ service: 'gmail', profile: 'work', command: 'gmail list', host: 'box', keyId: 'local', keyName: 'local', outcome: 'auth_failed', version: '3.23.1' });
    closeUsageStore();

    const text = await cli(['usage', '--by', 'profile']);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('gmail/work');
    expect(text.stdout).toContain('50%');

    const json = await cli(['usage', '--json']);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.by).toBe('command');
    expect(parsed.rows[0]).toMatchObject({ group: 'gmail list', count: 2, failures: 1 });
  });

  test('a bad option is a clean error, not a stack trace', async () => {
    const res = await cli(['usage', '--since', '1000d']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('INVALID_PARAMS');
    expect(res.stderr).not.toContain('    at ');
  });
});
