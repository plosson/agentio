import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveProfile, setProfile } from './config-manager';
import { clearVaultCache, saveVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import {
  clearPassphraseCache,
  resetPassphraseProvider,
  setPassphraseProvider,
  type PassphraseProvider,
} from '../vault/passphrase';
import { writePointer } from '../vault/pointer';

class MemoryPassphraseStore implements PassphraseProvider {
  store = new Map<string, string>();
  async get(a: string) { return this.store.get(a) ?? null; }
  async set(a: string, v: string) { this.store.set(a, v); }
  async delete(a: string) { this.store.delete(a); }
}

let tempHome = '';
let savedHome = '';
let vaultFile = '';

describe('resolveProfile multi-profile case', () => {
  beforeEach(async () => {
    savedHome = process.env.HOME || '';
    tempHome = await mkdtemp(join(tmpdir(), 'agentio-config-test-'));
    process.env.HOME = tempHome;
    vaultFile = join(tempHome, 'vault.enc');
    const mem = new MemoryPassphraseStore();
    setPassphraseProvider(mem);
    clearPassphraseCache();
    clearVaultCache();
    process.env.AGENTIO_PASSPHRASE = 'test-pw';
    await writePointer(vaultFile);
    await saveVault({ version: CURRENT_VAULT_VERSION, config: { profiles: {} }, credentials: {} });
    clearVaultCache();
  });

  afterEach(async () => {
    process.env.HOME = savedHome;
    resetPassphraseProvider();
    clearPassphraseCache();
    clearVaultCache();
    delete process.env.AGENTIO_PASSPHRASE;
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  test('returns names array when multiple profiles exist and none specified', async () => {
    await setProfile('telegram', 'work');
    await setProfile('telegram', 'personal');
    clearVaultCache();
    const r = await resolveProfile('telegram');
    if (r.profile === null && r.error === 'multiple') {
      expect(r.names).toEqual(['work', 'personal']);
    } else {
      throw new Error(`Expected multiple profiles error, got: ${JSON.stringify(r)}`);
    }
  });
});
