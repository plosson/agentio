import { afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writePointer } from '../../src/vault/pointer';
import { resetRemoteCache } from '../../src/auth/remote';
import { saveVault, clearVaultCache, CURRENT_VAULT_VERSION } from '../../src/vault/vault';
import { setPassphraseProvider, memoryOnlyProvider, clearPassphraseCache, resetPassphraseProvider } from '../../src/vault/passphrase';
import type { Config } from '../../src/types/config';
import type { StoredCredentials } from '../../src/types/tokens';

/**
 * Test helper: creates a vault at `$HOME/.config/agentio/vault.enc` (or the
 * provided path) pre-populated with the given config and credentials.
 * Must be called inside a test with HOME pointing at a temp dir.
 *
 * The caller is responsible for setting process.env.HOME before calling.
 * This helper also sets AGENTIO_PASSPHRASE on the current process so
 * saveVault can write. The caller is responsible for propagating both
 * HOME and AGENTIO_PASSPHRASE to any subprocess it spawns.
 */
export async function seedVault(options: {
  config?: Config;
  credentials?: StoredCredentials;
  passphrase?: string;
  vaultPath?: string;
} = {}): Promise<{ passphrase: string; vaultPath: string }> {
  const { homedir } = await import('os');
  const { join, dirname } = await import('path');
  const { mkdir } = await import('fs/promises');
  const { existsSync } = await import('fs');

  const vaultPath =
    options.vaultPath ?? join(process.env.HOME || homedir(), '.config', 'agentio', 'vault.enc');
  const passphrase = options.passphrase ?? 'test-passphrase-1234';

  if (!existsSync(dirname(vaultPath))) {
    await mkdir(dirname(vaultPath), { recursive: true, mode: 0o700 });
  }

  // Memory-only provider so saveVault's resolvePassphraseOrThrow doesn't
  // touch the passphrase store during in-process seeding.
  setPassphraseProvider(memoryOnlyProvider());

  await writePointer(vaultPath);
  process.env.AGENTIO_PASSPHRASE = passphrase;
  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: options.config ?? { profiles: {} },
    credentials: options.credentials ?? {},
  });

  return { passphrase, vaultPath };
}

type SeedOptions = Parameters<typeof seedVault>[0];

/** Variables a test's environment must not inherit; saved before each test and restored exactly after. */
const ISOLATED_ENV = ['HOME', 'AGENTIO_HOME', 'AGENTIO_TOKEN'] as const;

/**
 * Registers a beforeEach/afterEach pair: a fresh temp HOME with a seeded vault
 * for every test, and full teardown (HOME restored, passphrase env and caches
 * cleared, directory removed). Call at module level; register any extra hooks
 * after it so they run once the vault exists.
 *
 * AGENTIO_HOME is pointed into the temp HOME and AGENTIO_TOKEN is cleared, so
 * neither a shell's AGENTIO_HOME nor a real login (remote mode) can reach past
 * the temp folder. Both are restored exactly afterwards; an unset one stays unset.
 *
 * `home()` and `env()` throw outside a test, so nothing can fall back to an
 * empty path, which would mean the current folder. `env()` is the environment
 * for a CLI spawned from the test: the same isolation, plus the passphrase.
 */
export function withTempVault(
  prefix: string,
  seed: () => SeedOptions,
): { home: () => string; env: () => Record<string, string> } {
  let tempHome = '';
  const saved: Partial<Record<(typeof ISOLATED_ENV)[number], string>> = {};

  beforeEach(async () => {
    for (const name of ISOLATED_ENV) saved[name] = process.env[name];
    tempHome = await mkdtemp(join(tmpdir(), prefix));
    process.env.HOME = tempHome;
    process.env.AGENTIO_HOME = join(tempHome, '.config', 'agentio');
    delete process.env.AGENTIO_TOKEN;
    resetRemoteCache();
    await seedVault(seed());
  });

  afterEach(async () => {
    for (const name of ISOLATED_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetRemoteCache();
    delete process.env.AGENTIO_PASSPHRASE;
    resetPassphraseProvider();
    clearPassphraseCache();
    clearVaultCache();
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
    tempHome = '';
  });

  const home = () => {
    if (!tempHome) throw new Error('withTempVault: no temp home outside a test');
    return tempHome;
  };
  const env = () => ({
    PATH: process.env.PATH ?? '',
    HOME: home(),
    AGENTIO_HOME: join(home(), '.config', 'agentio'),
    AGENTIO_TOKEN: '',
    AGENTIO_PASSPHRASE: process.env.AGENTIO_PASSPHRASE ?? '',
  });
  return { home, env };
}
