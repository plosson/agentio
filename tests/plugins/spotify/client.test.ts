import { afterEach, describe, expect, test } from 'bun:test';
import { SpotifyClient } from '../../../src/plugins/spotify/client';
import type { SpotifyCredentials } from '../../../src/plugins/spotify/types';
import { CliError } from '../../../src/utils/errors';
import { LIBRARY_BATCH_SIZE, PLAYLIST_BATCH_SIZE } from '../../../src/plugins/spotify/types';

const CREDENTIALS: SpotifyCredentials = {
  clientId: 'client',
  accessToken: 'token',
  refreshToken: 'refresh',
  expiryDate: Date.now() + 60_000,
  authorizedAt: new Date().toISOString(),
  scopes: ['user-library-read', 'user-modify-playback-state'],
  userId: 'user1',
  displayName: 'User',
  readOnly: false,
};

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string; body?: string }> = [];

function stubSequence(
  handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
): void {
  let i = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return handler(u, init);
  }) as unknown as typeof fetch;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

function client(overrides: Partial<SpotifyCredentials> = {}): SpotifyClient {
  return new SpotifyClient({ ...CREDENTIALS, ...overrides });
}

describe('library batching', () => {
  test.each([0, 40, 41, 100, 101])('librarySave batches %i uris', async (n) => {
    stubSequence([() => json({})]);
    const uris = Array.from({ length: n }, (_, i) => `spotify:track:${String(i).padStart(22, '0')}`);
    await client().librarySave(uris);
    const expectedCalls = n === 0 ? 0 : Math.ceil(n / LIBRARY_BATCH_SIZE);
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(expectedCalls);
    if (n > 0) {
      const first = JSON.parse(calls[0].body!);
      expect(first.uris.length).toBe(Math.min(n, LIBRARY_BATCH_SIZE));
    }
  });

  test('playlist add batches 100', async () => {
    stubSequence([
      () => json({ snapshot_id: 's1' }),
      () => json({ snapshot_id: 's2' }),
    ]);
    const uris = Array.from({ length: 101 }, (_, i) => `spotify:track:${String(i).padStart(22, 'a')}`);
    const result = await client().addPlaylistItems('pl', uris);
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[0].body!).uris.length).toBe(PLAYLIST_BATCH_SIZE);
    expect(JSON.parse(calls[1].body!).uris.length).toBe(1);
    expect(result.added).toBe(101);
    expect(result.snapshotId).toBe('s2');
  });
});

describe('paging', () => {
  test('--all stops when a page returns fewer than requested', async () => {
    stubSequence([
      () => json({
        items: Array.from({ length: 50 }, (_, i) => ({
          added_at: '2026-01-01T00:00:00Z',
          track: {
            id: `t${i}`,
            name: `T${i}`,
            uri: `spotify:track:t${i}`,
            duration_ms: 1000,
            artists: [{ name: 'A' }],
          },
        })),
        total: 999,
        limit: 50,
        offset: 0,
      }),
      () => json({
        items: Array.from({ length: 10 }, (_, i) => ({
          added_at: '2026-01-01T00:00:00Z',
          track: {
            id: `u${i}`,
            name: `U${i}`,
            uri: `spotify:track:u${i}`,
            duration_ms: 1000,
            artists: [{ name: 'A' }],
          },
        })),
        total: 999,
        limit: 50,
        offset: 50,
      }),
    ]);
    const { items } = await client().libraryTracks({ all: true });
    expect(items.length).toBe(60);
    expect(calls.length).toBe(2);
  });

  test('search rejects offset+limit over 1000', async () => {
    await expect(
      client().search({ query: 'x', types: ['track'], limit: 50, offset: 960 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  test('followed artists use cursor paging', async () => {
    stubSequence([
      () => json({
        artists: {
          items: [{ id: 'a1', name: 'A1', uri: 'spotify:artist:a1' }],
          cursors: { after: 'cursor1' },
        },
      }),
      () => json({
        artists: {
          items: [{ id: 'a2', name: 'A2', uri: 'spotify:artist:a2' }],
          cursors: {},
        },
      }),
    ]);
    const { items } = await client().libraryArtists({ all: true });
    expect(items.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(calls[0].url).toContain('/me/following');
    expect(calls[1].url).toContain('after=cursor1');
  });
});

describe('429 and quota', () => {
  test('Retry-After is followed up to 3 times', async () => {
    let hits = 0;
    stubSequence([
      () => {
        hits += 1;
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
      },
      () => {
        hits += 1;
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
      },
      () => {
        hits += 1;
        return json({ id: 'me', display_name: 'Me', uri: 'spotify:user:me' });
      },
    ]);
    const me = await client().me();
    expect(me.id).toBe('me');
    expect(hits).toBe(3);
  });

  test('QUOTA_EXCEEDED stops without retrying', async () => {
    let hits = 0;
    stubSequence([
      () => {
        hits += 1;
        return new Response(JSON.stringify({ error: { message: 'QUOTA_EXCEEDED' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        });
      },
    ]);
    await expect(client().me()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(hits).toBe(1);
  });

  test('retry limit ends the loop', async () => {
    stubSequence([
      () => new Response('no', { status: 429, headers: { 'Retry-After': '0' } }),
      () => new Response('no', { status: 429, headers: { 'Retry-After': '0' } }),
      () => new Response('no', { status: 429, headers: { 'Retry-After': '0' } }),
      () => new Response('no', { status: 429, headers: { 'Retry-After': '0' } }),
    ]);
    await expect(client().me()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls.length).toBe(4); // initial + 3 retries
  });
});

describe('player errors', () => {
  test('204 player status returns null', async () => {
    stubSequence([() => new Response(null, { status: 204 })]);
    expect(await client().playerState()).toBeNull();
  });

  test('NO_ACTIVE_DEVICE maps correctly', async () => {
    stubSequence([
      () => json({ error: { status: 404, message: 'Player command failed', reason: 'NO_ACTIVE_DEVICE' } }, 404),
    ]);
    await expect(client().pause()).rejects.toMatchObject({ code: 'NO_ACTIVE_DEVICE' });
  });

  test('PREMIUM_REQUIRED maps correctly', async () => {
    stubSequence([
      () => json({ error: { status: 403, message: 'Player command failed', reason: 'PREMIUM_REQUIRED' } }, 403),
    ]);
    await expect(client().play()).rejects.toMatchObject({ code: 'PREMIUM_REQUIRED' });
  });

  test('enrichNoActiveDevice lists devices', async () => {
    const c = client();
    stubSequence([
      () => json({ devices: [{ id: 'd1', name: 'Phone', type: 'Smartphone', is_active: false, is_restricted: false, volume_percent: 10 }] }),
    ]);
    const enriched = await c.enrichNoActiveDevice(
      new CliError('NO_ACTIVE_DEVICE', 'No active Spotify device'),
    );
    expect(enriched.message).toContain('Phone');
    expect(enriched.suggestion).toContain('--device');
  });
});

describe('read-only credentials flag', () => {
  test('credentials.readOnly is visible to callers', () => {
    expect(client({ readOnly: true }).getCredentials().readOnly).toBe(true);
  });
});

describe('stdin-style empty/whitespace URI lists', () => {
  test('empty list makes no request', async () => {
    stubSequence([() => json({})]);
    await client().librarySave([]);
    expect(calls.length).toBe(0);
  });
});
