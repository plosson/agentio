import { describe, expect, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import { chooseProfileName } from './profile-commands';

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
