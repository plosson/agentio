import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { seedVault } from '../vault/test-helpers';
import { loadVault, clearVaultCache } from '../vault/vault';

/**
 * Subprocess tests for `agentio config import` — specifically the fix
 * that makes import preserve top-level config fields the export blob
 * doesn't contain (server, gateway/daemon).
 *
 * Why subprocess: config import touches the real config-manager and
 * credential store (vault-backed). Each test runs in an isolated
 * `mkdtemp` HOME + seeded vault so the tests never touch the
 * developer's real ~/.config/agentio.
 */

let tempHome = '';
let passphraseStoreFile = '';
const TEST_PASSPHRASE = 'test-pw-12345';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-config-import-test-'));
  passphraseStoreFile = join(tempHome, 'passphrase-store.json');
  await mkdir(join(tempHome, '.config', 'agentio'), {
    recursive: true,
    mode: 0o700,
  });
});

afterEach(async () => {
  delete process.env.AGENTIO_PASSPHRASE;
  delete process.env.AGENTIO_PASSPHRASE_STORE;
  clearVaultCache();
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
    tempHome = '';
  }
});

async function writeConfig(content: unknown): Promise<void> {
  process.env.HOME = tempHome;
  process.env.AGENTIO_PASSPHRASE = TEST_PASSPHRASE;
  clearVaultCache();
  await seedVault({
    config: content as any,
    passphrase: TEST_PASSPHRASE,
  });
}

async function readConfig(): Promise<Record<string, unknown>> {
  process.env.HOME = tempHome;
  process.env.AGENTIO_PASSPHRASE = TEST_PASSPHRASE;
  clearVaultCache();
  const v = await loadVault();
  return v.config as unknown as Record<string, unknown>;
}

/**
 * Extract the set of profile names for a given service from a config,
 * tolerating both string ("p1") and object ({name: "p1"}) shapes.
 * Profiles can be either form per the ProfileValue type.
 */
function profileNames(
  config: Record<string, unknown>,
  service: string
): string[] {
  const profiles = (config.profiles as Record<string, unknown[]>)?.[service];
  if (!Array.isArray(profiles)) return [];
  return profiles.map((p) =>
    typeof p === 'string' ? p : (p as { name: string }).name
  );
}

async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: tempHome,
      AGENTIO_PASSPHRASE: TEST_PASSPHRASE,
      AGENTIO_PASSPHRASE_STORE: `memory:${passphraseStoreFile}`,
      ...extraEnv,
    },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

/**
 * Helper: take a config snapshot (which becomes the "exported state"),
 * call `config export --all`, parse the AGENTIO_KEY + AGENTIO_CONFIG
 * vars from stdout. Returns those for use with a follow-up import.
 */
async function exportCurrentConfig(): Promise<{
  key: string;
  blob: string;
}> {
  const res = await runCli(['config', 'export', '--all']);
  if (res.exitCode !== 0) {
    throw new Error(
      `export failed: exit ${res.exitCode}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
  }
  const keyMatch = res.stdout.match(/AGENTIO_KEY=(\S+)/);
  const configMatch = res.stdout.match(/AGENTIO_CONFIG=(\S+)/);
  if (!keyMatch || !configMatch) {
    throw new Error(
      `could not parse export output:\nstdout: ${res.stdout}`
    );
  }
  return { key: keyMatch[1], blob: configMatch[1] };
}

interface ServerStateLike {
  apiKey: string;
  tokens: Array<Record<string, unknown>>;
  clients: Array<Record<string, unknown>>;
}

const SAMPLE_SERVER: ServerStateLike = {
  apiKey: 'srv_preserved_key_for_test_xxxx',
  tokens: [
    {
      token: 'preserved-bearer-token-value',
      clientId: 'cli_preserved_x',
      scope: 'mcp',
      issuedAt: 1700000000000,
      // Far in the future so findToken doesn't treat it as expired.
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  ],
  clients: [
    {
      clientId: 'cli_preserved_x',
      clientName: 'Preserved Test Client',
      redirectUris: ['http://localhost/cb'],
      createdAt: 1700000000000,
    },
  ],
};

/* ------------------------------------------------------------------ */
/* replace mode preserves config.server                               */
/* ------------------------------------------------------------------ */

describe('config import (replace mode) — preserves config.server', () => {
  test('preserves apiKey, tokens, and clients across import', async () => {
    // 1. Seed: existing config with profiles + server.*
    await writeConfig({
      profiles: { gmail: [{ name: 'work' }] },
      server: SAMPLE_SERVER,
    });

    // 2. Snapshot the current state via export.
    const { key, blob } = await exportCurrentConfig();

    // 3. Mutate the saved config (different profiles) but keep server.*
    //    so we can assert the IMPORT preserves the still-current
    //    server, not just whatever was at export time.
    await writeConfig({
      profiles: { gchat: [{ name: 'irrelevant' }] },
      server: SAMPLE_SERVER,
    });

    // 4. Run import — replace mode (no --merge).
    const importRes = await runCli(['config', 'import'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    // 5. Assert: profiles came from the export, server.* preserved.
    const final = await readConfig();
    expect(profileNames(final, 'gmail')).toEqual(['work']);
    expect(profileNames(final, 'gchat')).toEqual([]);

    const server = final.server as Record<string, unknown>;
    expect(server).toBeDefined();
    expect(server.apiKey).toBe(SAMPLE_SERVER.apiKey);
    expect(server.tokens).toEqual(SAMPLE_SERVER.tokens);
    expect(server.clients).toEqual(SAMPLE_SERVER.clients);
  });

  test('replace still REPLACES profiles (not merge)', async () => {
    await writeConfig({
      profiles: { gmail: [{ name: 'p1' }] },
      server: SAMPLE_SERVER,
    });
    const { key, blob } = await exportCurrentConfig();

    // Change current profiles to something completely different — the
    // import should overwrite this with the exported {gmail:[p1]}, NOT
    // accumulate.
    await writeConfig({
      profiles: { jira: [{ name: 'tickets' }] },
      server: SAMPLE_SERVER,
    });
    const importRes = await runCli(['config', 'import'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    const final = await readConfig();
    expect(profileNames(final, 'gmail')).toEqual(['p1']);
    // jira is gone — replace, not merge.
    expect(profileNames(final, 'jira')).toEqual([]);
  });

  test('replace replaces env vars too', async () => {
    await writeConfig({
      profiles: { gmail: [{ name: 'p1' }] },
      env: { OLD_VAR: 'old' },
      server: SAMPLE_SERVER,
    });
    const { key, blob } = await exportCurrentConfig();

    // Mutate to new env, then import the snapshot — env should revert
    // to the snapshot's env.
    await writeConfig({
      profiles: {},
      env: { NEW_VAR: 'new' },
      server: SAMPLE_SERVER,
    });
    const importRes = await runCli(['config', 'import'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    const final = await readConfig();
    const env = final.env as Record<string, unknown>;
    expect(env).toBeDefined();
    expect(env.OLD_VAR).toBe('old');
    expect(env.NEW_VAR).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* merge mode keeps working                                            */
/* ------------------------------------------------------------------ */

describe('config import (merge mode) — preserves server + adds profiles', () => {
  test('--merge adds new profiles without removing existing ones', async () => {
    await writeConfig({
      profiles: { gmail: [{ name: 'p1' }] },
      server: SAMPLE_SERVER,
    });
    const { key, blob } = await exportCurrentConfig();

    await writeConfig({
      profiles: { jira: [{ name: 'tickets' }] },
      server: SAMPLE_SERVER,
    });
    const importRes = await runCli(['config', 'import', '--merge'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    const final = await readConfig();
    // Both original (jira) and imported (gmail) profiles present.
    expect(profileNames(final, 'jira')).toContain('tickets');
    expect(profileNames(final, 'gmail')).toContain('p1');
  });

  test('--merge preserves config.server (matching replace behavior)', async () => {
    await writeConfig({
      profiles: { gmail: [{ name: 'p1' }] },
      server: SAMPLE_SERVER,
    });
    const { key, blob } = await exportCurrentConfig();

    await writeConfig({
      profiles: {},
      server: SAMPLE_SERVER,
    });
    const importRes = await runCli(['config', 'import', '--merge'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    const final = await readConfig();
    expect(final.server).toEqual(SAMPLE_SERVER);
  });
});
