import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { CliError } from '../../src/utils/errors';

// Only the Atlassian exchange is replaced; bun's module mocks are process-wide.
const jiraRefresh = mock(async (_refreshToken: string) => {
  throw new Error('{"error":"unauthorized_client","error_description":"refresh_token is invalid"}');
});
const realJira = await import('../../src/plugins/jira/oauth');
mock.module('../../src/plugins/jira/oauth', () => ({ ...realJira, refreshJiraToken: jiraRefresh }));

const { getProfileStatuses } = await import('../../src/commands/status');

const HOUR = 60 * 60 * 1000;

withTempVault('agentio-status-test-', () => ({
  config: {
    profiles: {
      // Alphabetical by service in ALL_SERVICES order: the broken one sits in the middle.
      jira: [{ name: 'dead' }],
      telegram: [{ name: 'bot' }],
      slack: [{ name: 'nocreds' }],
    },
  },
  credentials: {
    jira: { dead: { accessToken: 'old', refreshToken: 'rt', expiryDate: Date.now() - HOUR, cloudId: 'c', siteUrl: 's' } },
    telegram: { bot: { botToken: 'bot-secret', channelId: '1' } },
  },
}));

beforeEach(() => {
  jiraRefresh.mockClear();
});

describe('getProfileStatuses', () => {
  test('a profile whose refresh token is rejected marks its own row and the rest are still reported', async () => {
    const statuses = await getProfileStatuses({ test: true });

    // Every configured profile is present; the dead one did not abandon the run.
    expect(statuses.map((s) => `${s.service}/${s.profile}`).sort()).toEqual([
      'jira/dead', 'slack/nocreds', 'telegram/bot',
    ]);

    const dead = statuses.find((s) => s.profile === 'dead')!;
    expect(dead.status).toBe('invalid');
    expect(dead.error).toBe('refresh token rejected, re-authenticate');

    // The profile with nothing stored is reported as such, not as a failure.
    expect(statuses.find((s) => s.profile === 'nocreds')!.status).toBe('no-creds');
  });

  test('--no-test still lists every profile without touching a provider', async () => {
    const statuses = await getProfileStatuses({ test: false });
    expect(statuses.map((s) => s.status).sort()).toEqual(['no-creds', 'skipped', 'skipped']);
    expect(jiraRefresh).not.toHaveBeenCalled();
  });

  test('a failure of the whole session still stops the run, rather than mislabelling every profile', async () => {
    // What a revoked hub token looks like: the same error for every profile, and
    // reporting twenty invalid rows would bury the one thing that is actually wrong.
    jiraRefresh.mockImplementation(async () => {
      throw new CliError('AUTH_FAILED', 'The vault hub rejected this token');
    });
    // The refresh module wraps a thrown error as TOKEN_EXPIRED, so drive the
    // session failure through the credential read instead.
    const store = await import('../../src/auth/token-store');
    const original = store.getCredentials;
    const spy = mock(async (...args: Parameters<typeof original>) => {
      if (args[0] === 'jira') throw new CliError('NETWORK_ERROR', 'Cannot reach the vault hub');
      return original(...args);
    });
    mock.module('../../src/auth/token-store', () => ({ ...store, getCredentials: spy }));
    try {
      await expect(getProfileStatuses({ test: true })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    } finally {
      mock.module('../../src/auth/token-store', () => ({ ...store, getCredentials: original }));
    }
  });
});
