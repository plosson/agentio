import { afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writePointer } from './pointer';
import { saveVault, clearVaultCache, CURRENT_VAULT_VERSION } from './vault';
import { setPassphraseProvider, memoryOnlyProvider, clearPassphraseCache, resetPassphraseProvider } from './passphrase';
import type { Config } from '../types/config';
import type { StoredCredentials } from '../types/tokens';

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

/**
 * Registers a beforeEach/afterEach pair: a fresh temp HOME with a seeded vault
 * for every test, and full teardown (HOME restored, passphrase env and caches
 * cleared, directory removed). Call at module level; register any extra hooks
 * after it so they run once the vault exists.
 */
export function withTempVault(prefix: string, seed: () => SeedOptions): { home: () => string } {
  let tempHome = '';
  let savedHome = '';

  beforeEach(async () => {
    savedHome = process.env.HOME || '';
    tempHome = await mkdtemp(join(tmpdir(), prefix));
    process.env.HOME = tempHome;
    await seedVault(seed());
  });

  afterEach(async () => {
    process.env.HOME = savedHome;
    delete process.env.AGENTIO_PASSPHRASE;
    resetPassphraseProvider();
    clearPassphraseCache();
    clearVaultCache();
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  return { home: () => tempHome };
}
