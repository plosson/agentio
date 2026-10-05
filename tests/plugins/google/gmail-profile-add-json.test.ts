import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';

const vault = withTempVault('agentio-gmail-json-', () => ({ config: { profiles: {} } as never }));

test('--describe --json: Gmail needs a browser sign-in and nothing else', async () => {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'gmail', 'profile', 'add', '--describe', '--json'], { stdout: 'pipe', stderr: 'pipe', env: vault.env() });
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({ v: 1, event: 'needs', service: 'gmail', inputs: [], auth: 'browser' });
}, 20_000);

test('--json prints the Google address to open, opens no browser, and listens for the callback', async () => {
  // An `open` command that would leave a mark if anything ran it.
  const bin = await mkdtemp(join(tmpdir(), 'agentio-bin-'));
  const mark = join(bin, 'opened');
  for (const name of ['open', 'xdg-open']) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "$@" > "${mark}"\n`);
    await chmod(join(bin, name), 0o755);
  }
  const env = { ...vault.env(), PATH: `${bin}:${process.env.PATH}` };
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'gmail', 'profile', 'add', '--json'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  const event = JSON.parse(new TextDecoder().decode(value).split('\n')[0]);
  expect(event.event).toBe('open');
  const url = new URL(event.url);
  expect(url.host).toBe('accounts.google.com');
  const redirect = url.searchParams.get('redirect_uri')!;
  expect(redirect).toMatch(/^http:\/\/localhost:30(0\d|10)\/callback$/);
  // The callback server is already listening.
  const res = await fetch(`${redirect}?error=access_denied`);
  expect(res.status).toBe(200);
  expect(await proc.exited).not.toBe(0);
  expect(existsSync(mark)).toBe(false);
}, 20_000);
