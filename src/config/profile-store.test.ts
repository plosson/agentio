import { describe, expect, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import { loadVault } from '../vault/vault';
import { createApiKey, listApiKeys } from '../auth/api-keys';
import { chooseProfileName, deleteProfile, deleteProfileForKey, renameProfile, renameProfileForKey, saveProfile, saveProfileForKey } from './profile-store';

withTempVault('agentio-profile-store-test-', () => ({
  config: { profiles: { gmail: [{ name: 'me@example.com' }], github: ['octocat'] } },
}));

describe('chooseProfileName', () => {
  test('an explicit --profile wins, whatever the vault holds', async () => {
    expect(await chooseProfileName('gmail', { explicit: 'work', derived: 'me@example.com', readOnly: true })).toBe('work');
  });

  test('a free derived name is used as is', async () => {
    expect(await chooseProfileName('gmail', { derived: 'other@example.com' })).toBe('other@example.com');
    expect(await chooseProfileName('gmail', { derived: 'other@example.com', readOnly: true })).toBe('other@example.com');
  });

  test('a read-only profile for an account that already has one gets the -readonly suffix', async () => {
    expect(await chooseProfileName('gmail', { derived: 'me@example.com', readOnly: true })).toBe('me@example.com-readonly');
  });

  test('the suffix rule applies to every service, legacy string entries included', async () => {
    expect(await chooseProfileName('github', { derived: 'octocat', readOnly: true })).toBe('octocat-readonly');
  });

  test('without --read-only the derived name is kept even when taken, as before', async () => {
    expect(await chooseProfileName('gmail', { derived: 'me@example.com' })).toBe('me@example.com');
  });
});

describe('saveProfile', () => {
  test('writes the entry and the credentials together', async () => {
    await saveProfile('telegram', 'bot', { botToken: 't', chatId: '1' }, { readOnly: true });
    const vault = await loadVault();
    expect(vault.config.profiles.telegram).toEqual([{ name: 'bot', readOnly: true }]);
    expect(vault.credentials.telegram).toEqual({ bot: { botToken: 't', chatId: '1' } });
  });

  test('replaces an existing profile in place, legacy string entries included', async () => {
    await saveProfile('github', 'octocat', { accessToken: 'new' });
    const vault = await loadVault();
    expect(vault.config.profiles.github).toEqual([{ name: 'octocat' }]);
    expect(vault.credentials.github).toEqual({ octocat: { accessToken: 'new' } });
  });

  test('refuses a name that is empty or contains "/"', async () => {
    await expect(saveProfile('gmail', 'a/b', { a: 1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(saveProfile('gmail', ' ', { a: 1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect((await loadVault()).config.profiles.gmail).toEqual([{ name: 'me@example.com' }]);
  });

  test('is the inverse of deleteProfile', async () => {
    await saveProfile('gmail', 'new@example.com', { access_token: 'a' });
    expect(await deleteProfile('gmail', 'new@example.com')).toBe(true);
    const vault = await loadVault();
    expect(vault.config.profiles.gmail).toEqual([{ name: 'me@example.com' }]);
    expect(vault.credentials.gmail?.['new@example.com']).toBeUndefined();
  });
});

describe('the keyed operations', () => {
  const keyFor = async (scope: string[] | '*') => (await createApiKey({ name: 'k', allowedProfiles: scope, canManageProfiles: true }, 'https://hub')).key.id;

  test('save creates a free name and grants it to the key in one write', async () => {
    const key = await keyFor(['gmail/me@example.com']);
    expect(await saveProfileForKey(key, 'telegram', 'bot', { botToken: 't' }, { readOnly: true })).toBe(true);
    const vault = await loadVault();
    expect(vault.config.profiles.telegram).toEqual([{ name: 'bot', readOnly: true }]);
    expect(vault.credentials.telegram).toEqual({ bot: { botToken: 't' } });
    expect((await listApiKeys())[0].allowedProfiles).toEqual(['gmail/me@example.com', 'telegram/bot']);
  });

  test('save replaces a name the key reaches, and refuses one it does not', async () => {
    const key = await keyFor(['gmail/me@example.com']);
    expect(await saveProfileForKey(key, 'gmail', 'me@example.com', { access_token: 'fresh' }, {})).toBe(true);
    expect((await loadVault()).credentials.gmail).toEqual({ 'me@example.com': { access_token: 'fresh' } });

    // github/octocat exists but is outside the key's list, so nothing is written.
    expect(await saveProfileForKey(key, 'github', 'octocat', { accessToken: 'x' }, {})).toBe(false);
    expect((await loadVault()).credentials.github).toBeUndefined();
  });

  test('delete and rename reach exactly what the key reaches, and a rename carries the scope with it', async () => {
    const key = await keyFor(['gmail/me@example.com']);
    expect(await deleteProfileForKey(key, 'github', 'octocat')).toBe(false);
    expect(await renameProfileForKey(key, 'github', 'octocat', 'someone')).toBe('not-found');
    expect((await loadVault()).config.profiles.github).toEqual(['octocat']);

    expect(await renameProfileForKey(key, 'gmail', 'me@example.com', 'work')).toBe('renamed');
    expect(await deleteProfileForKey(key, 'gmail', 'work')).toBe(true);
  });

  test('a wildcard key reaches everything', async () => {
    const key = await keyFor('*');
    expect(await saveProfileForKey(key, 'github', 'octocat', { accessToken: 'x' }, {})).toBe(true);
    expect(await deleteProfileForKey(key, 'github', 'octocat')).toBe(true);
  });
});

describe('renameProfile', () => {
  test('moves the entry with its flag, the credentials, and every key scope naming it', async () => {
    await saveProfile('gmail', 'me@example.com', { access_token: 'a' }, { readOnly: true });
    const { key } = await createApiKey({ name: 'scoped', allowedProfiles: ['gmail/me@example.com', 'github/octocat'] }, 'https://hub');
    const { key: star } = await createApiKey({ name: 'star', allowedProfiles: '*' }, 'https://hub');

    expect(await renameProfile('gmail', 'me@example.com', 'work')).toBe('renamed');
    const vault = await loadVault();
    expect(vault.config.profiles.gmail).toEqual([{ name: 'work', readOnly: true }]);
    expect(vault.credentials.gmail).toEqual({ work: { access_token: 'a' } });

    const keys = await listApiKeys();
    expect(keys.find((k) => k.id === key.id)!.allowedProfiles).toEqual(['gmail/work', 'github/octocat']);
    expect(keys.find((k) => k.id === star.id)!.allowedProfiles).toBe('*');
  });

  test('an unknown source, a taken target, and an invalid name each leave the vault alone', async () => {
    expect(await renameProfile('gmail', 'nope', 'work')).toBe('not-found');
    await saveProfile('gmail', 'other@example.com', { access_token: 'b' });
    expect(await renameProfile('gmail', 'other@example.com', 'me@example.com')).toBe('taken');
    await expect(renameProfile('gmail', 'other@example.com', 'a/b')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect((await loadVault()).credentials.gmail?.['other@example.com']).toEqual({ access_token: 'b' });
  });

  test('renaming to the same name is a no-op that still reports the profile exists', async () => {
    expect(await renameProfile('gmail', 'me@example.com', 'me@example.com')).toBe('renamed');
    expect(await renameProfile('gmail', 'nope', 'nope')).toBe('not-found');
  });

  test('a profile with no credentials stored still renames', async () => {
    expect(await renameProfile('github', 'octocat', 'hubber')).toBe('renamed');
    const vault = await loadVault();
    expect(vault.config.profiles.github).toEqual([{ name: 'hubber' }]);
    expect(vault.credentials.github).toBeUndefined();
  });
});
