import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listProfileRefs, listProfiles, resolveProfile } from '../../src/config/config-manager';
import { clearVaultCache, saveVault, CURRENT_VAULT_VERSION } from '../../src/vault/vault';
import { clearPassphraseCache, resetPassphraseProvider, setPassphraseProvider, type PassphraseProvider } from '../../src/vault/passphrase';
import { writePointer } from '../../src/vault/pointer';
import { findServicePlugin } from '../../src/plugins/registry';

class MemoryPassphraseStore implements PassphraseProvider {
  store = new Map<string, string>();
  async get(a: string) { return this.store.get(a) ?? null; }
  async set(a: string, v: string) { this.store.set(a, v); }
  async delete(a: string) { this.store.delete(a); }
}

let tempHome = '';
let savedHome = '';

// pocketalert was removed in 3.38.0; vaults written before still hold its profiles.
describe('vault with a profile of a removed service (pocketalert)', () => {
  beforeEach(async () => {
    savedHome = process.env.HOME || '';
    tempHome = await mkdtemp(join(tmpdir(), 'agentio-removed-svc-'));
    process.env.HOME = tempHome;
    setPassphraseProvider(new MemoryPassphraseStore());
    clearPassphraseCache();
    clearVaultCache();
    process.env.AGENTIO_PASSPHRASE = 'test-pw';
    await writePointer(join(tempHome, 'vault.enc'));
    await saveVault({
      version: CURRENT_VAULT_VERSION,
      config: { profiles: { pocketalert: ['default'], pagerio: ['default'] } },
      credentials: { pocketalert: { default: { apiKey: 'old-key' } }, pagerio: { default: { url: 'https://pager.example/x' } } },
    } as never);
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

  test('the vault still loads and other services resolve', async () => {
    expect(findServicePlugin('pocketalert')).toBeUndefined();
    const refs = await listProfileRefs();
    expect(refs.some((r) => r.service === 'pagerio' && r.name === 'default')).toBe(true);
    const all = await listProfiles();
    expect(all.find((s) => s.service === 'pagerio')?.profiles.map((p) => p.name)).toEqual(['default']);
    const r = await resolveProfile('pagerio');
    expect(r.profile).toBe('default');
  });
});
