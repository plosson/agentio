import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { withTempVault } from '../helpers/vault';
import { loadVault, lockVault, unlockVault } from '../../src/vault/vault';
import { createApiKey, listApiKeys, revokeApiKey } from '../../src/auth/api-keys';
import { createRequestHandler } from '../../src/daemon/api';

/**
 * End to end: the real hub runs in this process on a random port with a seeded
 * vault, and the CLI runs as a subprocess with only AGENTIO_TOKEN and an empty
 * HOME. No vault exists on the client side.
 */

const PASSPHRASE = 'hub-pw-12345';
withTempVault('agentio-remote-hub-', () => ({
  passphrase: PASSPHRASE,
  config: { profiles: { telegram: [{ name: 'alerts' }, { name: 'bare' }], slack: [{ name: 'ops', readOnly: true }], gdrive: [{ name: 'docs' }] } },
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
  lockVault();
  await unlockVault(PASSPHRASE);
  const handle = createRequestHandler({ version: 'test' });
  server = Bun.serve({ port: 0, fetch: (req, srv) => handle(req, srv) });
  url = `http://127.0.0.1:${server.port}`;
  token = (await createApiKey({ name: 'agent', allowedProfiles: ['telegram/alerts', 'telegram/bare', 'slack/ops'], readOnly: false }, url)).token;
  clientHome = await mkdtemp(join(tmpdir(), 'agentio-remote-client-'));
});

afterEach(async () => {
  server.stop(true);
  await rm(clientHome, { recursive: true, force: true }).catch(() => {});
});

async function cli(args: string[], extraEnv: Record<string, string> = {}, stdin = '') {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: clientHome, AGENTIO_TOKEN: token, ...extraEnv };
  delete env.AGENTIO_PASSPHRASE;
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], { stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env });
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
    // The hub says which profiles hold nothing; no credential fetch was needed to know.
    expect(parsed.services.telegram.find((p: { profile: string }) => p.profile === 'bare').status).toBe('no-creds');
  });

  test('profile list works; doctor reports the hub', async () => {
    const list = await cli(['profile', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('alerts');
    expect(list.stdout).toContain('ops [read-only]');

    const doctor = await cli(['doctor']);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain('✓ Hub');
    expect(doctor.stdout).toContain('3 profile(s)');
  });

  test('a service command resolves its profile and read-only flag through the hub', async () => {
    // slack/ops is read-only on the hub, so a write is refused before any network call.
    const res = await cli(['slack', 'send', 'hello']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('PERMISSION_DENIED');
    expect(res.stderr).toContain('read-only on the vault hub');
  });

  test('owner-only commands are refused with a pointer to the hub', async () => {
    for (const args of [['vault', 'status'], ['profile', 'reauth', 'telegram'], ['telegram', 'profile', 'update', '--profile', 'bare', '--read-only']]) {
      const res = await cli(args);
      expect(res.exitCode).toBe(3);
      expect(res.stderr).toContain('not available in remote mode');
      expect(res.stderr).toContain(url);
    }
  });

  test('a profile write is refused up front, before any prompt, without the managing right', async () => {
    const res = await cli(['sql', 'profile', 'add'], {}, 'sqlite://:memory:\n');
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('PERMISSION_DENIED');
    expect(res.stderr).toContain(url);
    // The gate ran before the handler, so the setup dialogue never started.
    expect(res.stderr).not.toContain('Connection URL');
  });

  test('a managing key renames and removes a profile on the hub', async () => {
    const manager = (await createApiKey({ name: 'manager', allowedProfiles: ['telegram/alerts'], canManageProfiles: true }, url)).token;

    const renamed = await cli(['profile', 'rename', 'telegram', 'alerts', 'sirens'], { AGENTIO_TOKEN: manager });
    expect(renamed.exitCode).toBe(0);
    expect(renamed.stdout).toContain('Renamed profile "alerts" to "sirens"');
    const afterRename = await loadVault();
    expect(afterRename.config.profiles.telegram).toEqual([{ name: 'sirens' }, { name: 'bare' }]);
    expect(afterRename.credentials.telegram?.sirens).toMatchObject({ botToken: 'bot-secret' });

    const removed = await cli(['profile', 'remove', 'telegram', 'sirens'], { AGENTIO_TOKEN: manager });
    expect(removed.exitCode).toBe(0);
    expect((await loadVault()).config.profiles.telegram).toEqual([{ name: 'bare' }]);
  });

  test('a managing key cannot touch a profile outside its allow-list', async () => {
    const manager = (await createApiKey({ name: 'narrow', allowedProfiles: ['telegram/alerts'], canManageProfiles: true }, url)).token;
    // Out of the key's list is refused, not silently reported as done, and nothing is written.
    for (const args of [['profile', 'remove', 'slack', 'ops'], ['profile', 'rename', 'slack', 'ops', 'mine']]) {
      const res = await cli(args, { AGENTIO_TOKEN: manager });
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('PERMISSION_DENIED');
      expect((await loadVault()).config.profiles.slack).toEqual([{ name: 'ops', readOnly: true }]);
    }
  });

  test('a hub that predates the flag is told apart from a key that lacks it', async () => {
    // An older hub answers the listing without canManageProfiles at all.
    const bare = Bun.serve({ port: 0, fetch: () => Response.json({ profiles: [] }) });
    try {
      const res = await cli(['sql', 'profile', 'add'], {
        AGENTIO_TOKEN: (await createApiKey({ name: 'old', allowedProfiles: '*' }, `http://127.0.0.1:${bare.port}`)).token,
      }, 'sqlite://:memory:\n');
      expect(res.stderr).toContain('does not support managing profiles');
      expect(res.stderr).not.toContain('Ask the hub owner');
    } finally {
      bare.stop(true);
    }
  });

  test('profile add on the agent lands on the hub, and the key can use it at once', async () => {
    const adder = (await createApiKey({ name: 'adder', allowedProfiles: ['telegram/alerts'], canManageProfiles: true }, url)).token;
    const added = await cli(['sql', 'profile', 'add', '--profile', 'mem', '--read-only'], { AGENTIO_TOKEN: adder }, 'sqlite://:memory:\n');
    expect(added.exitCode).toBe(0);

    // The entry and its read-only flag reached the hub's vault through the PUT.
    expect((await loadVault()).config.profiles.sql).toEqual([{ name: 'mem', readOnly: true }]);

    // And the adding key may use what it just added, without a new token.
    const query = await cli(['sql', 'query', 'SELECT 1 AS one'], { AGENTIO_TOKEN: adder });
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toContain('one');
  });

  test('a token outside the allow-list is refused by the hub, not the client', async () => {
    const res = await cli(['gdrive', 'list']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/PROFILE_NOT_FOUND|No gdrive profile/);
  });

  test('a revoked token fails with the hub\'s reason', async () => {
    for (const k of await listApiKeys()) await revokeApiKey(k.id);
    const res = await cli(['status', '--no-test']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('rejected this token');
  });
});
