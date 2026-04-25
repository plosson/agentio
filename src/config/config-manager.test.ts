import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateGatewayToDaemon, resolveProfile, setProfile } from './config-manager';
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
    await setProfile('whatsapp', 'work');
    await setProfile('whatsapp', 'personal');
    clearVaultCache();
    const r = await resolveProfile('whatsapp');
    expect(r.error).toBe('multiple');
    expect(r.names).toEqual(['work', 'personal']);
  });
});

describe('migrateGatewayToDaemon', () => {
  test('copies gateway into daemon when daemon absent', () => {
    const input = { profiles: {}, gateway: { apiKey: 'k' } };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon).toEqual({ apiKey: 'k' });
    expect(out.gateway).toBeUndefined();
  });

  test('leaves daemon alone when already present', () => {
    const input = {
      profiles: {},
      gateway: { apiKey: 'old' },
      daemon: { apiKey: 'new' },
    };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon?.apiKey).toBe('new');
    expect(out.gateway).toBeUndefined();
  });

  test('is a no-op when neither is present', () => {
    const input = { profiles: {} };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon).toBeUndefined();
    expect(out.gateway).toBeUndefined();
  });
});
