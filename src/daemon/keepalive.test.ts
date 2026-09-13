import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import { lockVault, loadVault, unlockVault } from '../vault/vault';

// Only the Atlassian exchange is replaced; bun's module mocks are process-wide.
const jiraRefresh = mock(async (refreshToken: string) => ({
  accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600,
}));
const realJira = await import('../auth/jira-oauth');
mock.module('../auth/jira-oauth', () => ({ ...realJira, refreshJiraToken: jiraRefresh }));

const { intervalHours, keepaliveRunning, runRefreshPass, startKeepalive, stopKeepalive,
  DEFAULT_INTERVAL_HOURS, MAX_INTERVAL_HOURS, MIN_INTERVAL_HOURS } = await import('./keepalive');

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
  delete process.env.AGENTIO_KEEPALIVE_HOURS;
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

  test('a second pass does not start over one already running', async () => {
    let entered!: () => void;
    const reachedRefresh = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    // Only the first profile parks; the fixture has two, and parking both would deadlock.
    let parked = false;
    jiraRefresh.mockImplementation(async (refreshToken: string) => {
      if (!parked) {
        parked = true;
        entered();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600 };
    });

    const inFlight = runRefreshPass();
    await reachedRefresh; // the first pass is now parked inside a refresh
    const overlapping = await runRefreshPass();
    expect(overlapping).toEqual({ refreshed: 0, fresh: 0, skipped: 0, failed: 0 });

    release();
    await inFlight;
  });

  test('a locked vault is left alone entirely', async () => {
    lockVault();
    expect(await runRefreshPass()).toEqual({ refreshed: 0, fresh: 0, skipped: 0, failed: 0 });
    expect(jiraRefresh).not.toHaveBeenCalled();
  });
});

describe('the interval', () => {
  test('defaults, accepts hours, clamps out of range, and treats nonsense as the default', () => {
    expect(intervalHours(undefined)).toBe(DEFAULT_INTERVAL_HOURS);
    expect(intervalHours('')).toBe(DEFAULT_INTERVAL_HOURS);
    expect(intervalHours('6')).toBe(6);
    expect(intervalHours('nope')).toBe(DEFAULT_INTERVAL_HOURS);
    expect(intervalHours('-1')).toBe(DEFAULT_INTERVAL_HOURS);
    expect(intervalHours('0')).toBe(0);

    // Below the floor, and the sub-second value that would spin.
    expect(intervalHours('0.0001')).toBe(MIN_INTERVAL_HOURS);
    // "Monthly" is the natural thing to reach for, and unclamped it overflows
    // setTimeout's 32-bit millisecond argument and fires immediately, forever.
    expect(intervalHours('720')).toBe(MAX_INTERVAL_HOURS);
    expect(MAX_INTERVAL_HOURS * 60 * 60 * 1000).toBeLessThan(2 ** 31 - 1);
  });

  test('zero leaves the loop off; a real interval turns it on and stopping is idempotent', () => {
    startKeepalive(0);
    expect(keepaliveRunning()).toBe(false);

    startKeepalive(24);
    expect(keepaliveRunning()).toBe(true);
    // Starting again must not strand the previous timer.
    startKeepalive(24);
    expect(keepaliveRunning()).toBe(true);

    stopKeepalive();
    expect(keepaliveRunning()).toBe(false);
    stopKeepalive();
    expect(keepaliveRunning()).toBe(false);
  });

  test('starting passes immediately rather than waiting out the first gap', async () => {
    startKeepalive(24);
    await Bun.sleep(50);
    stopKeepalive();
    expect(jiraRefresh).toHaveBeenCalled();
  });
});
