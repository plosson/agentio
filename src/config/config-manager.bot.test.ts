import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setProfile, setProfileBot, getProfileBot } from './config-manager';
import { clearVaultCache, saveVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import {
  clearPassphraseCache,
  resetPassphraseProvider,
  setPassphraseProvider,
  type PassphraseProvider,
} from '../vault/passphrase';
import { writePointer } from '../vault/pointer';
import { CliError } from '../utils/errors';

class MemoryPassphraseStore implements PassphraseProvider {
  store = new Map<string, string>();
  async get(a: string) { return this.store.get(a) ?? null; }
  async set(a: string, v: string) { this.store.set(a, v); }
  async delete(a: string) { this.store.delete(a); }
}

let tempHome = '';
let savedHome = '';

describe('setProfileBot / getProfileBot', () => {
  beforeEach(async () => {
    savedHome = process.env.HOME || '';
    tempHome = await mkdtemp(join(tmpdir(), 'agentio-bot-cfg-'));
    process.env.HOME = tempHome;
    setPassphraseProvider(new MemoryPassphraseStore());
    clearPassphraseCache();
    clearVaultCache();
    process.env.AGENTIO_PASSPHRASE = 'test-pw';
    await writePointer(join(tempHome, 'vault.enc'));
    await saveVault({
      version: CURRENT_VAULT_VERSION,
      config: { profiles: {} },
      credentials: {},
    });
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

  test('stores bot config alongside the profile', async () => {
    await setProfile('telegram', 'p1');
    await setProfileBot('telegram', 'p1', {
      enabled: true, model: 'sonnet', permissionMode: 'bypassPermissions',
    });
    clearVaultCache();
    const cfg = await getProfileBot('telegram', 'p1');
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.model).toBe('sonnet');
    expect(cfg?.permissionMode).toBe('bypassPermissions');
  });

  test('rejects bot.enabled=true on read-only profile', async () => {
    await setProfile('telegram', 'p1', { readOnly: true });
    clearVaultCache();
    let thrown: unknown;
    try {
      await setProfileBot('telegram', 'p1', {
        enabled: true, model: 'sonnet', permissionMode: 'bypassPermissions',
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CliError);
  });

  test('returns undefined for profile with no bot config', async () => {
    await setProfile('telegram', 'p1');
    clearVaultCache();
    expect(await getProfileBot('telegram', 'p1')).toBeUndefined();
  });

  test('throws PROFILE_NOT_FOUND when profile does not exist', async () => {
    let thrown: unknown;
    try {
      await setProfileBot('telegram', 'nonexistent', {
        enabled: false, model: 'sonnet', permissionMode: 'bypassPermissions',
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CliError);
  });

  test('disabling bot does not require write access (read-only allowed)', async () => {
    // Allow disabling on a read-only profile (only enable=true is blocked).
    await setProfile('telegram', 'p1', { readOnly: true });
    clearVaultCache();
    await setProfileBot('telegram', 'p1', {
      enabled: false, model: 'sonnet', permissionMode: 'bypassPermissions',
    });
    clearVaultCache();
    const cfg = await getProfileBot('telegram', 'p1');
    expect(cfg?.enabled).toBe(false);
  });
});
