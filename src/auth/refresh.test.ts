import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedVault } from '../vault/test-helpers';
import { clearVaultCache } from '../vault/vault';
import { clearPassphraseCache, resetPassphraseProvider } from '../vault/passphrase';
import { getCredentials } from './token-store';

// Replace only the network calls, before the module under test is loaded.
// Module mocks are process-wide in bun, so the rest of each module is kept
// intact for the other test files that import it.
const jiraRefresh = mock(async (refreshToken: string) => {
  await new Promise((r) => setTimeout(r, 20));
  return { accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600 };
});
const revolutRefresh = mock(async () => ({ accessToken: 'rev-new', expiresIn: 2400 }));
const realJira = await import('./jira-oauth');
const realRevolut = await import('./revolut-oauth');
mock.module('./jira-oauth', () => ({ ...realJira, refreshJiraToken: jiraRefresh }));
mock.module('./revolut-oauth', () => ({ ...realRevolut, refreshRevolutToken: revolutRefresh }));

const { getFreshCredentials, REFRESH_BUFFER_MS } = await import('./refresh');

const HOUR = 60 * 60 * 1000;
let tempHome = '';
let savedHome = '';

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-refresh-test-'));
  process.env.HOME = tempHome;
  jiraRefresh.mockClear();
  revolutRefresh.mockClear();
  await seedVault({
    config: { profiles: { jira: [{ name: 'stale' }, { name: 'fresh' }], revolut: [{ name: 'noexp' }], telegram: [{ name: 'bot' }], gchat: [{ name: 'hook' }] } },
    credentials: {
      jira: {
        stale: { accessToken: 'jira-old', refreshToken: 'r1', expiryDate: Date.now() + 60_000, cloudId: 'c', siteUrl: 's' },
        fresh: { accessToken: 'jira-ok', refreshToken: 'r2', expiryDate: Date.now() + HOUR, cloudId: 'c', siteUrl: 's' },
      },
      revolut: { noexp: { accessToken: 'rev-old', refreshToken: 'rr', clientId: 'id', privateKey: 'k', redirectUri: 'u', environment: 'sandbox' } },
      telegram: { bot: { botToken: 't', channelId: '1' } },
      gchat: { hook: { type: 'webhook', webhookUrl: 'https://chat.example/hook' } },
    },
  });
});

afterEach(async () => {
  process.env.HOME = savedHome;
  delete process.env.AGENTIO_PASSPHRASE;
  resetPassphraseProvider();
  clearPassphraseCache();
  clearVaultCache();
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('getFreshCredentials', () => {
  test('a token inside the buffer is refreshed and written back with the rotated refresh token', async () => {
    const { credentials, refreshed } = await getFreshCredentials('jira', 'stale');
    expect(refreshed).toBe(true);
    expect(credentials.accessToken).toBe('jira-new');
    expect(credentials.refreshToken).toBe('r1-rotated');
    expect(await getCredentials('jira', 'stale')).toMatchObject({ accessToken: 'jira-new', refreshToken: 'r1-rotated' });
  });

  test('a fresh token is returned untouched', async () => {
    const { credentials, refreshed } = await getFreshCredentials('jira', 'fresh');
    expect(refreshed).toBe(false);
    expect(credentials.accessToken).toBe('jira-ok');
    expect(jiraRefresh).not.toHaveBeenCalled();
  });

  test('a wider buffer makes a token stale that the default would keep', async () => {
    const { refreshed } = await getFreshCredentials('jira', 'fresh', { bufferMs: 2 * HOUR });
    expect(refreshed).toBe(true);
  });

  test('force refreshes a fresh token', async () => {
    const { refreshed } = await getFreshCredentials('jira', 'fresh', { force: true });
    expect(refreshed).toBe(true);
    expect(jiraRefresh).toHaveBeenCalledTimes(1);
  });

  test('concurrent callers for one profile share a single refresh', async () => {
    const results = await Promise.all([
      getFreshCredentials('jira', 'stale'),
      getFreshCredentials('jira', 'stale'),
      getFreshCredentials('jira', 'stale'),
    ]);
    expect(jiraRefresh).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.refreshed)).toEqual([true, false, false]);
    expect(results.every((r) => r.credentials.accessToken === 'jira-new')).toBe(true);
  });

  test('a missing expiry counts as stale for short-lived tokens', async () => {
    const { credentials, refreshed } = await getFreshCredentials('revolut', 'noexp');
    expect(refreshed).toBe(true);
    expect(credentials.accessToken).toBe('rev-new');
    expect(credentials.expiryDate).toBeGreaterThan(Date.now() + REFRESH_BUFFER_MS);
  });

  test('static credentials come back as stored', async () => {
    const { credentials, refreshed } = await getFreshCredentials('telegram', 'bot');
    expect(refreshed).toBe(false);
    expect(credentials).toEqual({ botToken: 't', channelId: '1' });
  });

  test('a profile of a refreshable service with nothing to refresh is left alone, even when forced', async () => {
    const { credentials, refreshed } = await getFreshCredentials('gchat', 'hook', { force: true });
    expect(refreshed).toBe(false);
    expect(credentials).toMatchObject({ type: 'webhook' });
  });

  test('a rejected refresh is TOKEN_EXPIRED and leaves the vault unchanged', async () => {
    jiraRefresh.mockImplementationOnce(async () => { throw new Error('invalid_grant'); });
    await expect(getFreshCredentials('jira', 'stale')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(await getCredentials('jira', 'stale')).toMatchObject({ accessToken: 'jira-old', refreshToken: 'r1' });
  });

  test('a profile without credentials is AUTH_FAILED', async () => {
    await expect(getFreshCredentials('jira', 'nope')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
