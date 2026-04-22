import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { seedVault } from '../vault/test-helpers';
import { loadVault, clearVaultCache } from '../vault/vault';

/**
 * Subprocess tests for `agentio server tokens list|revoke|clear`. They
 * seed the vault directly with a known set of tokens so we can avoid
 * spinning up a real OAuth flow per test.
 */

let tempHome = '';
let keychainFile = '';
const TEST_PASSPHRASE = 'test-pw-12345';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-tokens-test-'));
  keychainFile = join(tempHome, 'keychain.json');
  await mkdir(join(tempHome, '.config', 'agentio'), {
    recursive: true,
    mode: 0o700,
  });
});

afterEach(async () => {
  delete process.env.AGENTIO_PASSPHRASE;
  delete process.env.AGENTIO_KEYCHAIN;
  clearVaultCache();
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
    tempHome = '';
  }
});

interface Token {
  token: string;
  clientId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
}

async function seedTokens(tokens: Token[]): Promise<void> {
  process.env.HOME = tempHome;
  process.env.AGENTIO_PASSPHRASE = TEST_PASSPHRASE;
  clearVaultCache();
  await seedVault({
    config: {
      profiles: {},
      server: {
        apiKey: 'srv_test_key_for_seeded_tests',
        tokens,
      },
    } as any,
    passphrase: TEST_PASSPHRASE,
  });
}

async function readTokensFromConfig(): Promise<Token[]> {
  process.env.HOME = tempHome;
  process.env.AGENTIO_PASSPHRASE = TEST_PASSPHRASE;
  clearVaultCache();
  const vault = await loadVault();
  const cfg = vault.config as unknown as { server?: { tokens?: Token[] } };
  return cfg.server?.tokens ?? [];
}

async function readConfig(): Promise<Record<string, unknown>> {
  process.env.HOME = tempHome;
  process.env.AGENTIO_PASSPHRASE = TEST_PASSPHRASE;
  clearVaultCache();
  const vault = await loadVault();
  return vault.config as unknown as Record<string, unknown>;
}

async function runCli(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: tempHome,
      AGENTIO_PASSPHRASE: TEST_PASSPHRASE,
      AGENTIO_KEYCHAIN: `memory:${keychainFile}`,
    },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

// Generated lazily so the timestamps are always current — `expiresAt` is
// relative to "now" at the moment the test runs, not a hardcoded epoch.
function makeSampleTokens(): Token[] {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  return [
    {
      token: 'aaaaaaaaaaaa1111111111111111111111111111111',
      clientId: 'cli_first',
      scope: 'gchat:default',
      issuedAt: now,
      expiresAt: now + 30 * day,
    },
    {
      token: 'bbbbbbbbbbbb2222222222222222222222222222222',
      clientId: 'cli_second',
      scope: 'gmail:work,slack:team',
      issuedAt: now,
      expiresAt: now + 30 * day,
    },
    {
      token: 'cccccccccccc3333333333333333333333333333333',
      clientId: 'cli_third',
      scope: '',
      issuedAt: now - 60 * day,
      // Already expired (issued 60 days ago, expired 30 days ago).
      expiresAt: now - 30 * day,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* tokens list                                                        */
/* ------------------------------------------------------------------ */

describe('agentio server tokens list', () => {
  test('reports "no tokens" when none are issued', async () => {
    await seedTokens([]);
    const { exitCode, stdout } = await runCli(['server', 'tokens', 'list']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No tokens issued yet');
  });

  test('reports each token with id prefix, client, scope, dates', async () => {
    await seedTokens(makeSampleTokens());
    const { exitCode, stdout } = await runCli(['server', 'tokens', 'list']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('3 token(s) issued');
    expect(stdout).toContain('aaaaaaaaaaaa');
    expect(stdout).toContain('bbbbbbbbbbbb');
    expect(stdout).toContain('cccccccccccc');
    expect(stdout).toContain('cli_first');
    expect(stdout).toContain('cli_second');
    expect(stdout).toContain('cli_third');
    expect(stdout).toContain('gchat:default');
    expect(stdout).toContain('gmail:work,slack:team');
  });

  test('marks expired tokens with (EXPIRED)', async () => {
    await seedTokens(makeSampleTokens());
    const { stdout } = await runCli(['server', 'tokens', 'list']);
    // Only the third sample token is expired.
    const lines = stdout.split('\n');
    const thirdLine = lines.find((l) => l.includes('cccccccccccc'));
    expect(thirdLine).toBeDefined();
    expect(thirdLine).toContain('EXPIRED');
    const firstLine = lines.find((l) => l.includes('aaaaaaaaaaaa'));
    expect(firstLine).not.toContain('EXPIRED');
  });
});

/* ------------------------------------------------------------------ */
/* tokens revoke                                                      */
/* ------------------------------------------------------------------ */

describe('agentio server tokens revoke', () => {
  test('revokes a token by 12-char prefix and persists', async () => {
    await seedTokens(makeSampleTokens());
    const { exitCode, stdout } = await runCli([
      'server',
      'tokens',
      'revoke',
      'aaaaaaaaaaaa',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Revoked token aaaaaaaaaaaa');
    const remaining = await readTokensFromConfig();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((t) => t.clientId)).toEqual([
      'cli_second',
      'cli_third',
    ]);
  });

  test('revokes a token by full opaque value', async () => {
    const samples = makeSampleTokens();
    await seedTokens(samples);
    const full = samples[1].token;
    const { exitCode } = await runCli(['server', 'tokens', 'revoke', full]);
    expect(exitCode).toBe(0);
    const remaining = await readTokensFromConfig();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((t) => t.clientId)).toEqual([
      'cli_first',
      'cli_third',
    ]);
  });

  test('non-matching id → non-zero exit, NOT_FOUND error', async () => {
    await seedTokens(makeSampleTokens());
    const { exitCode, stderr } = await runCli([
      'server',
      'tokens',
      'revoke',
      'nope_does_not_exist',
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('No token found matching');
    // Persisted state must not have changed.
    const remaining = await readTokensFromConfig();
    expect(remaining).toHaveLength(3);
  });

  test('ambiguous prefix → non-zero exit, INVALID_PARAMS error', async () => {
    // Both seeded tokens that start with the same letter would collide.
    const samples = makeSampleTokens();
    await seedTokens([
      { ...samples[0], token: 'shared_prefix_111111111111111111111111111111' },
      { ...samples[1], token: 'shared_prefix_222222222222222222222222222222' },
    ]);
    const { exitCode, stderr } = await runCli([
      'server',
      'tokens',
      'revoke',
      'shared_prefix',
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Ambiguous prefix');
    const remaining = await readTokensFromConfig();
    expect(remaining).toHaveLength(2);
  });

  test('preserves apiKey and other server fields when revoking', async () => {
    await seedTokens(makeSampleTokens());
    await runCli(['server', 'tokens', 'revoke', 'aaaaaaaaaaaa']);
    const cfg = await readConfig();
    const server = cfg.server as Record<string, unknown>;
    expect(server.apiKey).toBe('srv_test_key_for_seeded_tests');
  });
});

/* ------------------------------------------------------------------ */
/* tokens clear                                                       */
/* ------------------------------------------------------------------ */

describe('agentio server tokens clear', () => {
  test('removes all tokens and reports the count', async () => {
    await seedTokens(makeSampleTokens());
    const { exitCode, stdout } = await runCli([
      'server',
      'tokens',
      'clear',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Cleared 3 token(s)');
    const remaining = await readTokensFromConfig();
    expect(remaining).toHaveLength(0);
  });

  test('clear on an empty list reports 0 tokens', async () => {
    await seedTokens([]);
    const { exitCode, stdout } = await runCli([
      'server',
      'tokens',
      'clear',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Cleared 0 token(s)');
  });

  test('clear preserves apiKey and other server fields', async () => {
    await seedTokens(makeSampleTokens());
    await runCli(['server', 'tokens', 'clear']);
    const cfg = await readConfig();
    const server = cfg.server as Record<string, unknown>;
    expect(server.apiKey).toBe('srv_test_key_for_seeded_tests');
    expect(server.tokens).toEqual([]);
  });
});
