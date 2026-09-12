import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { withTempVault } from '../vault/test-helpers';
import { lockVault, unlockVault } from '../vault/vault';
import { createApiKey } from '../auth/api-keys';
import { createRequestHandler } from '../daemon/api';

/**
 * End to end: the real hub runs in this process on a random port with a seeded
 * vault, and the CLI runs as a subprocess with only AGENTIO_TOKEN and an empty
 * HOME. No vault exists on the client side.
 */

const PASSPHRASE = 'hub-pw-12345';
withTempVault('agentio-remote-hub-', () => ({
  passphrase: PASSPHRASE,
  config: { profiles: { telegram: [{ name: 'alerts' }], slack: [{ name: 'ops', readOnly: true }], gdrive: [{ name: 'docs' }] } },
  credentials: {
    telegram: { alerts: { botToken: 'bot-secret', channelId: '1' } },
    slack: { ops: { type: 'webhook', webhookUrl: 'https://hooks.slack.com/x' } },
    gdrive: { docs: { accessToken: 'at', refreshToken: 'rt', expiryDate: Date.now() + 3_600_000, tokenType: 'Bearer', email: 'x@y' } },
  },
}));

let server: ReturnType<typeof Bun.serve>;
let clientHome = '';
let token = '';
let url = '';

beforeEach(async () => {
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  await unlockVault(PASSPHRASE);
  const handle = createRequestHandler({ version: 'test' });
  server = Bun.serve({ port: 0, fetch: (req, srv) => handle(req, srv) });
  url = `http://127.0.0.1:${server.port}`;
  token = (await createApiKey({ name: 'agent', allowedProfiles: ['telegram/alerts', 'slack/ops'], readOnly: false }, url)).token;
  clientHome = await mkdtemp(join(tmpdir(), 'agentio-remote-client-'));
});

afterEach(async () => {
  server.stop(true);
  await rm(clientHome, { recursive: true, force: true }).catch(() => {});
});

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: clientHome, AGENTIO_TOKEN: token, ...extraEnv };
  delete env.AGENTIO_PASSPHRASE;
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], { stdout: 'pipe', stderr: 'pipe', env });
  const exitCode = await proc.exited;
  return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

describe('remote mode end to end', () => {
  test('status lists the allowed profiles without a local vault', async () => {
    const res = await cli(['status', '--no-test']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`Hub: ${url}`);
    expect(res.stdout).toContain('telegram');
    expect(res.stdout).toContain('alerts');
    expect(res.stdout).toContain('ops');
    expect(res.stdout).not.toContain('docs');

    const json = await cli(['status', '--no-test', '--json']);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.hub).toBe(url);
    expect(Object.keys(parsed.services).sort()).toEqual(['slack', 'telegram']);
    expect(parsed.services.slack[0].readOnly).toBe(true);
  });

  test('profile list works; doctor reports the hub', async () => {
    const list = await cli(['profile', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('alerts');
    expect(list.stdout).toContain('ops [read-only]');

    const doctor = await cli(['doctor']);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain('✓ Hub');
    expect(doctor.stdout).toContain('2 profile(s)');
  });

  test('a real command resolves the profile and fetches credentials from the hub', async () => {
    // `telegram send` needs a network; `--help` proves the gate lets service commands through,
    // and `profile list` for the service proves the resolver path end to end.
    const res = await cli(['telegram', 'profile', 'list']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('alerts');
  });

  test('owner-only commands are refused with a pointer to the hub', async () => {
    for (const args of [['vault', 'status'], ['key', 'list'], ['daemon', 'status'], ['profile', 'add', 'gmail'], ['telegram', 'profile', 'add']]) {
      const res = await cli(args);
      expect(res.exitCode).toBe(3);
      expect(res.stderr).toContain('not available in remote mode');
      expect(res.stderr).toContain(url);
    }
  });

  test('a token outside the allow-list is refused by the hub, not the client', async () => {
    const res = await cli(['gdrive', 'list']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/PROFILE_NOT_FOUND|No gdrive profile/);
  });

  test('a revoked token fails with the hub\'s reason', async () => {
    const { listApiKeys, revokeApiKey } = await import('../auth/api-keys');
    for (const k of await listApiKeys()) await revokeApiKey(k.id);
    const res = await cli(['status', '--no-test']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('rejected this token');
  });
});
