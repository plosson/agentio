import { describe, expect, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import { loadVault } from '../vault/vault';
import { chooseProfileName, deleteProfile, saveProfile } from './profile-commands';

withTempVault('agentio-profile-commands-test-', () => ({
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
    await saveProfile('telegram', 'bot', { readOnly: true }, { botToken: 't', chatId: '1' });
    const vault = await loadVault();
    expect(vault.config.profiles.telegram).toEqual([{ name: 'bot', readOnly: true }]);
    expect(vault.credentials.telegram).toEqual({ bot: { botToken: 't', chatId: '1' } });
  });

  test('replaces an existing profile in place, legacy string entries included', async () => {
    await saveProfile('github', 'octocat', {}, { accessToken: 'new' });
    const vault = await loadVault();
    expect(vault.config.profiles.github).toEqual([{ name: 'octocat' }]);
    expect(vault.credentials.github).toEqual({ octocat: { accessToken: 'new' } });
  });

  test('is the inverse of deleteProfile', async () => {
    await saveProfile('gmail', 'new@example.com', {}, { access_token: 'a' });
    expect(await deleteProfile('gmail', 'new@example.com')).toBe(true);
    const vault = await loadVault();
    expect(vault.config.profiles.gmail).toEqual([{ name: 'me@example.com' }]);
    expect(vault.credentials.gmail?.['new@example.com']).toBeUndefined();
  });
});
