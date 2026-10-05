import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { SCOPES, type OAuthService } from '../../../src/plugins/google/oauth';

const vault = withTempVault('agentio-google-json-', () => ({ config: { profiles: {} } as never }));

// The seven services whose whole setup is a browser sign-in to Google.
const SERVICES: OAuthService[] = ['gmail', 'gcal', 'gtasks', 'gdocs', 'gsheets', 'gslides', 'gscript'];

// Sequential on purpose: each run listens on the same callback port range.
describe.each(SERVICES)('%s profile add --json', (service) => {
  test('--describe --json: a browser sign-in and nothing else', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', service, 'profile', 'add', '--describe', '--json'], { stdout: 'pipe', stderr: 'pipe', env: vault.env() });
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({ v: 1, event: 'needs', service, inputs: [], auth: 'browser' });
  }, 20_000);

  test('an unknown input id is refused before anything opens', async () => {
    const res = await runCli([service, 'profile', 'add', '--json', '--input', '-'], vault.env(), ['{"x":"1"}']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.map((e) => e.event)).toEqual(['error']);
    expect(res.events[0]).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(res.events[0].message).toContain('Unknown setup value "x"');
  }, 20_000);

  test('an empty first line is refused as input, before anything opens', async () => {
    const res = await runCli([service, 'profile', 'add', '--json', '--input', '-'], vault.env(), ['']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.map((e) => e.event)).toEqual(['error']);
    expect(res.events[0]).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(res.events[0].message).toContain('Expected the setup values as one JSON object');
  }, 20_000);

  test('--json prints the Google address to open for this service, opens no browser, and listens for the callback', async () => {
    // An `open` command that would leave a mark if anything ran it.
    const bin = await mkdtemp(join(tmpdir(), 'agentio-bin-'));
    const mark = join(bin, 'opened');
    for (const name of ['open', 'xdg-open']) {
      await writeFile(join(bin, name), `#!/bin/sh\necho "$@" > "${mark}"\n`);
      await chmod(join(bin, name), 0o755);
    }
    const env = { ...vault.env(), PATH: `${bin}:${process.env.PATH}` };
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', service, 'profile', 'add', '--json'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const event = JSON.parse(new TextDecoder().decode(value).split('\n')[0]);
    expect(event.event).toBe('open');
    const url = new URL(event.url);
    expect(url.host).toBe('accounts.google.com');
    const scope = url.searchParams.get('scope') ?? '';
    for (const wanted of SCOPES[service]) expect(scope).toContain(wanted);
    const redirect = url.searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/localhost:30(0\d|10)\/callback$/);
    // The callback server is already listening.
    const res = await fetch(`${redirect}?error=access_denied`);
    expect(res.status).toBe(200);
    expect(await proc.exited).toBe(2);
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    const error = rest.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'error');
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toContain('access_denied');
    expect(error.suggestion).toBeTruthy();
    expect(existsSync(mark)).toBe(false);
  }, 20_000);
});
