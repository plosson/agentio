import { writePointer } from './pointer';
import { saveVault, CURRENT_VAULT_VERSION } from './vault';
import { setPassphraseProvider, type PassphraseProvider } from './passphrase';
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

  // Use a dummy in-memory provider so saveVault's resolvePassphraseOrThrow
  // doesn't try to touch the passphrase store during in-process seeding.
  class DummyProvider implements PassphraseProvider {
    async get() { return null; }
    async set() { /* noop */ }
    async delete() { /* noop */ }
  }
  setPassphraseProvider(new DummyProvider());

  await writePointer(vaultPath);
  process.env.AGENTIO_PASSPHRASE = passphrase;
  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: options.config ?? { profiles: {} },
    credentials: options.credentials ?? {},
  });

  return { passphrase, vaultPath };
}
