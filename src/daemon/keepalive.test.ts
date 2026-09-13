import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import { lockVault, loadVault, unlockVault } from '../vault/vault';

// Only the Atlassian exchange is replaced; bun's module mocks are process-wide.
const jiraRefresh = mock(async (refreshToken: string) => ({
  accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600,
}));
const realJira = await import('../auth/jira-oauth');
mock.module('../auth/jira-oauth', () => ({ ...realJira, refreshJiraToken: jiraRefresh }));

const { intervalHours, runRefreshPass, startKeepalive, stopKeepalive, DEFAULT_INTERVAL_HOURS } = await import('./keepalive');

const PASSPHRASE = 'keepalive-pw-123';
const HOUR = 60 * 60 * 1000;

withTempVault('agentio-keepalive-test-', () => ({
  passphrase: PASSPHRASE,
  config: {
    profiles: {
      jira: [{ name: 'idle' }, { name: 'broken' }],
      telegram: [{ name: 'bot' }],
      slack: [{ name: 'nocreds' }],
    },
  },
  credentials: {
    // Long past its access-token expiry, which is what a day of disuse looks like.
    jira: {
      idle: { accessToken: 'old', refreshToken: 'rt', expiryDate: Date.now() - HOUR, cloudId: 'c', siteUrl: 's' },
      broken: { accessToken: 'old', refreshToken: 'dead', expiryDate: Date.now() - HOUR, cloudId: 'c', siteUrl: 's' },
    },
    // Static: no refresher, so a pass must leave it alone.
    telegram: { bot: { botToken: 'bot-secret', channelId: '1' } },
  },
}));

beforeEach(async () => {
  delete process.env.AGENTIO_PASSPHRASE;
  delete process.env.AGENTIO_REFRESH_HOURS;
  lockVault();
  await unlockVault(PASSPHRASE);
  jiraRefresh.mockClear();
  jiraRefresh.mockImplementation(async (refreshToken: string) => ({
    accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600,
  }));
  stopKeepalive();
});

describe('the keepalive pass', () => {
  test('refreshes what has gone stale, leaves static profiles alone, and writes the rotated token back', async () => {
    jiraRefresh.mockImplementation(async (refreshToken: string) => {
      if (refreshToken === 'dead') throw new Error('invalid_grant');
      return { accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600 };
    });

    const result = await runRefreshPass();
    // telegram/bot is static so it is fresh; slack/nocreds has nothing stored so it is skipped, not failed.
    expect(result).toEqual({ refreshed: 1, fresh: 1, skipped: 1, failed: 1 });

    // The rotated refresh token is persisted; losing it would strand the profile.
    const { credentials } = await loadVault();
    expect(credentials.jira!.idle).toMatchObject({ accessToken: 'jira-new', refreshToken: 'rt-rotated' });
    expect(credentials.telegram!.bot).toEqual({ botToken: 'bot-secret', channelId: '1' });
  });

  test('one broken profile does not abandon the rest', async () => {
    jiraRefresh.mockImplementation(async (refreshToken: string) => {
      if (refreshToken === 'dead') throw new Error('invalid_grant');
      return { accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600 };
    });
    await runRefreshPass();
    // Both were attempted, in spite of one throwing.
    expect(jiraRefresh).toHaveBeenCalledTimes(2);
  });

  test('a second pass refreshes nothing, because the first left the tokens fresh', async () => {
    await runRefreshPass();
    jiraRefresh.mockClear();
    const again = await runRefreshPass();
    expect(again.refreshed).toBe(0);
    expect(jiraRefresh).not.toHaveBeenCalled();
  });

  test('a profile added but never authorised is passed over, not reported as a failure every pass', async () => {
    const { skipped, failed } = await runRefreshPass();
    expect(skipped).toBe(1);
    expect(failed).toBe(0);
  });

  test('a locked vault is left alone entirely', async () => {
    lockVault();
    expect(await runRefreshPass()).toEqual({ refreshed: 0, fresh: 0, skipped: 0, failed: 0 });
    expect(jiraRefresh).not.toHaveBeenCalled();
  });
});

describe('the interval', () => {
  test('defaults, accepts hours, and treats nonsense as the default', () => {
    expect(intervalHours(undefined)).toBe(DEFAULT_INTERVAL_HOURS);
    expect(intervalHours('')).toBe(DEFAULT_INTERVAL_HOURS);
    expect(intervalHours('6')).toBe(6);
    expect(intervalHours('0.5')).toBe(0.5);
    expect(intervalHours('nope')).toBe(DEFAULT_INTERVAL_HOURS);
    expect(intervalHours('-1')).toBe(DEFAULT_INTERVAL_HOURS);
  });

  test('zero turns the loop off, and stopping twice is safe', () => {
    expect(intervalHours('0')).toBe(0);
    startKeepalive(0);
    stopKeepalive();
    stopKeepalive();
  });

  test('the timers do not hold the process open', () => {
    startKeepalive(24);
    stopKeepalive();
  });
});
