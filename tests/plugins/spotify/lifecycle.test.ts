import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliError } from '../../../src/utils/errors';
import { spotifyCredentialLifecycle } from '../../../src/plugins/spotify/lifecycle';
import type { SpotifyCredentials } from '../../../src/plugins/spotify/types';

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;

function creds(overrides: Partial<SpotifyCredentials> = {}): SpotifyCredentials {
  return {
    clientId: 'client',
    accessToken: 'access',
    refreshToken: 'refresh-old',
    expiryDate: Date.now() - 1000,
    authorizedAt: new Date().toISOString(),
    scopes: ['user-library-read'],
    userId: 'user1',
    displayName: 'User',
    readOnly: false,
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.HOME = originalHome;
});

describe('spotifyCredentialLifecycle', () => {
  test('secretFields lists refreshToken only', () => {
    expect(spotifyCredentialLifecycle.secretFields).toEqual(['refreshToken']);
  });

  test('rotates refresh token when returned', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const authorizedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const before = creds({ authorizedAt });
    const after = await spotifyCredentialLifecycle.refresh(before);
    expect(after.accessToken).toBe('access-new');
    expect(after.refreshToken).toBe('refresh-new');
    expect(after.authorizedAt).toBe(authorizedAt);
  });

  test('keeps old refresh token when none returned', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'access-new',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const after = await spotifyCredentialLifecycle.refresh(creds());
    expect(after.refreshToken).toBe('refresh-old');
  });

  test('invalid_grant becomes AUTH_EXPIRED', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token revoked' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    await expect(spotifyCredentialLifecycle.refresh(creds())).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
  });

  test('authorizedAt past 6 months fails before the network', async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(spotifyCredentialLifecycle.refresh(creds({ authorizedAt: old }))).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
    expect(called).toBe(false);
  });

  test('vault HOME uses mkdtemp (safety smoke)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentio-spotify-'));
    process.env.HOME = dir;
    expect(process.env.HOME?.startsWith(tmpdir())).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
