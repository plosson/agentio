import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { seedVault } from '../vault/test-helpers';
import { loadVault, clearVaultCache } from '../vault/vault';
import { encryptVault } from '../vault/crypto';
import { existsSync } from 'fs';

/**
 * Subprocess tests for `agentio config import` — specifically the fix
 * that makes import preserve top-level config fields the export blob
 * doesn't contain (unknown top-level fields from older versions).
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
  const res = await runCli(['vault', 'export', '--all']);
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

/**
 * An unknown top-level config field. Older vaults may carry sections this
 * version knows nothing about; import must leave them untouched.
 */
const LEGACY = { apiKey: 'srv_preserved_key_for_test_xxxx', note: 'opaque to this version' };

/* ------------------------------------------------------------------ */
/* replace mode preserves unknown top-level fields                    */
/* ------------------------------------------------------------------ */

describe('config import (replace mode) — preserves unknown top-level fields', () => {
  test('preserves an unknown field across import', async () => {
    // 1. Seed: existing config with profiles + an unknown field
    await writeConfig({
      profiles: { gmail: [{ name: 'work' }] },
      legacy: LEGACY,
    });

    // 2. Snapshot the current state via export.
    const { key, blob } = await exportCurrentConfig();

    // 3. Mutate the saved config (different profiles) but keep the unknown
    //    field so we can assert the IMPORT preserves the still-current
    //    value, not just whatever was at export time.
    await writeConfig({
      profiles: { gchat: [{ name: 'irrelevant' }] },
      legacy: LEGACY,
    });

    // 4. Run import — replace mode (no --merge).
    const importRes = await runCli(['vault', 'import'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    // 5. Assert: profiles came from the export, the unknown field preserved.
    const final = await readConfig();
    expect(profileNames(final, 'gmail')).toEqual(['work']);
    expect(profileNames(final, 'gchat')).toEqual([]);

    expect(final.legacy).toEqual(LEGACY);
  });

  test('replace still REPLACES profiles (not merge)', async () => {
    await writeConfig({
      profiles: { gmail: [{ name: 'p1' }] },
      legacy: LEGACY,
    });
    const { key, blob } = await exportCurrentConfig();

    // Change current profiles to something completely different — the
    // import should overwrite this with the exported {gmail:[p1]}, NOT
    // accumulate.
    await writeConfig({
      profiles: { jira: [{ name: 'tickets' }] },
      legacy: LEGACY,
    });
    const importRes = await runCli(['vault', 'import'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    const final = await readConfig();
    expect(profileNames(final, 'gmail')).toEqual(['p1']);
    // jira is gone — replace, not merge.
    expect(profileNames(final, 'jira')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* merge mode keeps working                                            */
/* ------------------------------------------------------------------ */

describe('config import (merge mode) — preserves unknown fields + adds profiles', () => {
  test('--merge adds new profiles without removing existing ones', async () => {
    await writeConfig({
      profiles: { gmail: [{ name: 'p1' }] },
      legacy: LEGACY,
    });
    const { key, blob } = await exportCurrentConfig();

    await writeConfig({
      profiles: { jira: [{ name: 'tickets' }] },
      legacy: LEGACY,
    });
    const importRes = await runCli(['vault', 'import', '--merge'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    const final = await readConfig();
    // Both original (jira) and imported (gmail) profiles present.
    expect(profileNames(final, 'jira')).toContain('tickets');
    expect(profileNames(final, 'gmail')).toContain('p1');
  });

  test('--merge preserves unknown fields (matching replace behavior)', async () => {
    await writeConfig({
      profiles: { gmail: [{ name: 'p1' }] },
      legacy: LEGACY,
    });
    const { key, blob } = await exportCurrentConfig();

    await writeConfig({
      profiles: {},
      legacy: LEGACY,
    });
    const importRes = await runCli(['vault', 'import', '--merge'], {
      AGENTIO_KEY: key,
      AGENTIO_CONFIG: blob,
    });
    expect(importRes.exitCode).toBe(0);

    const final = await readConfig();
    expect(final.legacy).toEqual(LEGACY);
  });
});

describe('config import (replace mode) — reconciles key scopes', () => {
  test('a key scoped to a profile the import drops loses that entry', async () => {
    // A blob that only knows gmail/work...
    await writeConfig({ profiles: { gmail: [{ name: 'work' }] } });
    const gmailOnly = await exportCurrentConfig();
    // ...imported over a vault whose key is scoped to gmail/work and gdrive/docs.
    await writeConfig({
      profiles: { gmail: [{ name: 'work' }], gdrive: [{ name: 'docs' }] },
      apiKeys: [{ id: 'k1', name: 'k', secretHash: 'ab'.repeat(32), allowedProfiles: ['gmail/work', 'gdrive/docs'], readOnly: false, createdAt: 'x' }],
    });
    expect((await runCli(['vault', 'import'], { AGENTIO_KEY: gmailOnly.key, AGENTIO_CONFIG: gmailOnly.blob })).exitCode).toBe(0);
    const final = await readConfig();
    expect((final.apiKeys as Array<{ allowedProfiles: unknown }>)[0].allowedProfiles).toEqual(['gmail/work']);
  });
});

/* ------------------------------------------------------------------ */
/* no vault yet: import creates one                                    */
/* ------------------------------------------------------------------ */

describe('config import on a machine with no vault', () => {
  const KEY = 'ab'.repeat(32);
  const blob = encryptVault(
    JSON.stringify({
      version: 1,
      config: { profiles: { gmail: [{ name: 'seeded' }] } },
      credentials: { gmail: { seeded: { token: 't' } } },
    }),
    KEY,
  );

  test('creates the vault at the default path from AGENTIO_PASSPHRASE', async () => {
    const res = await runCli(['vault', 'import'], { AGENTIO_KEY: KEY, AGENTIO_CONFIG: blob });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Vault created at');

    expect(existsSync(join(tempHome, '.config', 'agentio', 'vault.enc'))).toBe(true);
    const final = await readConfig();
    expect(profileNames(final, 'gmail')).toEqual(['seeded']);
  });

  test('fails cleanly off a TTY when no passphrase source is given', async () => {
    const res = await runCli(['vault', 'import'], {
      AGENTIO_KEY: KEY,
      AGENTIO_CONFIG: blob,
      AGENTIO_PASSPHRASE: '',
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('INVALID_PARAMS');
    expect(existsSync(join(tempHome, '.config', 'agentio', 'vault.path'))).toBe(false);
  });
});
