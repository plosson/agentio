import { describe, expect, test } from 'bun:test';

import { createOAuthStore, type PersistableOAuthState } from './oauth-store';

/**
 * Pure unit tests for the OAuth store. No subprocesses, no real config
 * file. The store takes an injectable `save` callback so we can capture
 * persistence without touching disk, and an injectable `now` so we can
 * test expiry without sleeping.
 */

interface Harness {
  store: ReturnType<typeof createOAuthStore>;
  saved: PersistableOAuthState[];
  setNow: (ms: number) => void;
}

function makeStore(
  initial?: Partial<PersistableOAuthState>,
  startTime = 1_700_000_000_000
): Harness {
  const saved: PersistableOAuthState[] = [];
  let nowMs = startTime;
  const store = createOAuthStore({
    initial,
    save: async (state) => {
      // Deep-clone to make sure callers don't accidentally mutate the
      // captured snapshot under our feet.
      saved.push(JSON.parse(JSON.stringify(state)));
    },
    now: () => nowMs,
  });
  return {
    store,
    saved,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

/* ------------------------------------------------------------------ */
/* clients                                                            */
/* ------------------------------------------------------------------ */

describe('OAuthStore — clients (DCR)', () => {
  test('registerClient persists and returns a client_id with cli_ prefix', async () => {
    const { store, saved } = makeStore();
    const c = await store.registerClient({
      clientName: 'Claude Code',
      redirectUris: ['http://localhost:53682/callback'],
    });
    expect(c.clientId).toMatch(/^cli_[A-Za-z0-9_-]+$/);
    // 16 random bytes base64url = 22 chars + "cli_" prefix = 26 chars
    expect(c.clientId.length).toBe(26);
    expect(c.clientName).toBe('Claude Code');
    expect(c.redirectUris).toEqual(['http://localhost:53682/callback']);
    expect(c.createdAt).toBeGreaterThan(0);
    expect(saved).toHaveLength(1);
    expect(saved[0].clients).toHaveLength(1);
    expect(saved[0].clients[0].clientId).toBe(c.clientId);
  });

  test('multiple registerClient calls produce distinct client_ids', async () => {
    const { store } = makeStore();
    const a = await store.registerClient({ redirectUris: ['x'] });
    const b = await store.registerClient({ redirectUris: ['y'] });
    expect(a.clientId).not.toBe(b.clientId);
  });

  test('redirectUris are deep-copied (caller mutation does not leak in)', async () => {
    const { store } = makeStore();
    const uris = ['http://a/cb', 'http://b/cb'];
    const c = await store.registerClient({ redirectUris: uris });
    uris.push('http://evil/cb');
    expect(c.redirectUris).toEqual(['http://a/cb', 'http://b/cb']);
  });

  test('findClient returns undefined for unknown id', () => {
    const { store } = makeStore();
    expect(store.findClient('cli_nope')).toBeUndefined();
  });

  test('findClient returns the registered client', async () => {
    const { store } = makeStore();
    const c = await store.registerClient({ redirectUris: ['x'] });
    expect(store.findClient(c.clientId)).toEqual(c);
  });

  test('listClients returns a copy (caller cannot mutate internal state)', async () => {
    const { store } = makeStore();
    await store.registerClient({ redirectUris: ['x'] });
    const list1 = store.listClients();
    list1.push({
      clientId: 'cli_injected',
      redirectUris: [],
      createdAt: 0,
    });
    const list2 = store.listClients();
    expect(list2).toHaveLength(1);
  });

  test('initial clients from constructor are loaded', () => {
    const { store } = makeStore({
      clients: [
        {
          clientId: 'cli_preexisting',
          redirectUris: ['http://x/cb'],
          createdAt: 1,
        },
      ],
    });
    expect(store.findClient('cli_preexisting')).toBeDefined();
    expect(store.listClients()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* tokens                                                             */
/* ------------------------------------------------------------------ */

describe('OAuthStore — tokens', () => {
  test('issueToken returns a 43-char base64url token (32 random bytes)', async () => {
    const { store } = makeStore();
    const t = await store.issueToken({
      clientId: 'cli_x',
      scope: 'gchat:default',
    });
    expect(t.token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url with no padding = 43 chars
    expect(t.token.length).toBe(43);
    expect(t.clientId).toBe('cli_x');
    expect(t.scope).toBe('gchat:default');
    expect(t.expiresAt - t.issuedAt).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('issued tokens persist on every call', async () => {
    const { store, saved } = makeStore();
    await store.issueToken({ clientId: 'a', scope: 's' });
    await store.issueToken({ clientId: 'b', scope: 's' });
    expect(saved).toHaveLength(2);
    expect(saved[1].tokens).toHaveLength(2);
  });

  test('findToken returns the token within its lifetime', async () => {
    const { store } = makeStore();
    const t = await store.issueToken({ clientId: 'x', scope: 's' });
    expect(store.findToken(t.token)).toEqual(t);
  });

  test('findToken returns undefined for unknown values', () => {
    const { store } = makeStore();
    expect(store.findToken('nope')).toBeUndefined();
  });

  test('findToken returns undefined after expiry (now > expiresAt)', async () => {
    const { store, setNow } = makeStore(undefined, 1_000_000);
    const t = await store.issueToken({ clientId: 'x', scope: 's' });
    expect(store.findToken(t.token)).toBeDefined();

    setNow(t.expiresAt + 1);
    expect(store.findToken(t.token)).toBeUndefined();
  });

  test('findToken does NOT auto-prune (expired token still in listTokens)', async () => {
    const { store, setNow } = makeStore(undefined, 1_000_000);
    const t = await store.issueToken({ clientId: 'x', scope: 's' });
    setNow(t.expiresAt + 1);
    expect(store.findToken(t.token)).toBeUndefined();
    // Still in the underlying array — pruneExpiredTokens is the explicit GC.
    expect(store.listTokens().some((x) => x.token === t.token)).toBe(true);
  });

  test('revokeToken returns true and persists when token existed', async () => {
    const { store, saved } = makeStore();
    const t = await store.issueToken({ clientId: 'x', scope: 's' });
    saved.length = 0;

    const removed = await store.revokeToken(t.token);
    expect(removed).toBe(true);
    expect(store.findToken(t.token)).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(saved[0].tokens).toEqual([]);
  });

  test('revokeToken returns false and does NOT persist when token unknown', async () => {
    const { store, saved } = makeStore();
    await store.issueToken({ clientId: 'x', scope: 's' });
    saved.length = 0;

    const removed = await store.revokeToken('does-not-exist');
    expect(removed).toBe(false);
    expect(saved).toHaveLength(0);
  });

  test('revokeAllTokens removes all tokens and returns the count', async () => {
    const { store, saved } = makeStore();
    await store.issueToken({ clientId: 'a', scope: 's' });
    await store.issueToken({ clientId: 'b', scope: 's' });
    await store.issueToken({ clientId: 'c', scope: 's' });
    saved.length = 0;

    const removed = await store.revokeAllTokens();
    expect(removed).toBe(3);
    expect(store.listTokens()).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0].tokens).toEqual([]);
  });

  test('pruneExpiredTokens removes only the expired ones', async () => {
    const { store, setNow } = makeStore(undefined, 1_000_000);
    const fresh = await store.issueToken({ clientId: 'fresh', scope: 's' });
    const stale = await store.issueToken({ clientId: 'stale', scope: 's' });

    setNow(stale.expiresAt + 1);
    // Both technically expired now (issued at the same time).
    const removed = await store.pruneExpiredTokens();
    expect(removed).toBe(2);

    // Issue a new one after fast-forward — should survive.
    const survivor = await store.issueToken({
      clientId: 'survivor',
      scope: 's',
    });
    expect(store.listTokens()).toEqual([survivor]);

    // Confirm the original two are gone.
    expect(store.findToken(fresh.token)).toBeUndefined();
    expect(store.findToken(stale.token)).toBeUndefined();
  });

  test('pruneExpiredTokens with nothing to prune does not call save', async () => {
    const { store, saved } = makeStore();
    await store.issueToken({ clientId: 'x', scope: 's' });
    saved.length = 0;
    const removed = await store.pruneExpiredTokens();
    expect(removed).toBe(0);
    expect(saved).toHaveLength(0);
  });

  test('listTokens returns a copy', async () => {
    const { store } = makeStore();
    await store.issueToken({ clientId: 'x', scope: 's' });
    const list = store.listTokens();
    list.length = 0;
    expect(store.listTokens()).toHaveLength(1);
  });

  test('initial tokens from constructor are loaded', () => {
    const initialToken = {
      token: 'preexisting-token',
      clientId: 'cli_x',
      scope: 's',
      issuedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    const { store } = makeStore({ tokens: [initialToken] });
    expect(store.findToken('preexisting-token')).toEqual(initialToken);
  });
});

/* ------------------------------------------------------------------ */
/* codes                                                              */
/* ------------------------------------------------------------------ */

describe('OAuthStore — auth codes (in-memory)', () => {
  test('createCode returns a 32-char base64url code', () => {
    const { store } = makeStore();
    const c = store.createCode({
      clientId: 'cli_x',
      redirectUri: 'http://localhost/cb',
      codeChallenge: 'challenge',
      scope: 'gchat:default',
    });
    expect(c.code).toMatch(/^[A-Za-z0-9_-]+$/);
    // 24 random bytes base64url = 32 chars
    expect(c.code.length).toBe(32);
    expect(c.clientId).toBe('cli_x');
    expect(c.redirectUri).toBe('http://localhost/cb');
    expect(c.codeChallenge).toBe('challenge');
    expect(c.scope).toBe('gchat:default');
  });

  test('consumeCode returns the code and removes it', () => {
    const { store } = makeStore();
    const c = store.createCode({
      clientId: 'cli_x',
      redirectUri: 'http://localhost/cb',
      codeChallenge: 'ch',
      scope: 's',
    });

    const first = store.consumeCode(c.code);
    expect(first).toEqual(c);

    // Second consume returns undefined — codes are one-shot.
    const second = store.consumeCode(c.code);
    expect(second).toBeUndefined();
  });

  test('consumeCode returns undefined for unknown code', () => {
    const { store } = makeStore();
    expect(store.consumeCode('nope')).toBeUndefined();
  });

  test('consumeCode returns undefined and removes the code if expired', () => {
    const { store, setNow } = makeStore(undefined, 1_000_000);
    const c = store.createCode({
      clientId: 'cli_x',
      redirectUri: 'http://localhost/cb',
      codeChallenge: 'ch',
      scope: 's',
    });

    setNow(c.expiresAt + 1);
    expect(store.consumeCode(c.code)).toBeUndefined();
    // Even though expired, it was deleted on the consume call.
    expect(store.consumeCode(c.code)).toBeUndefined();
  });

  test('codes are NOT persisted (save callback never sees them)', () => {
    const { store, saved } = makeStore();
    store.createCode({
      clientId: 'cli_x',
      redirectUri: 'http://localhost/cb',
      codeChallenge: 'ch',
      scope: 's',
    });
    expect(saved).toHaveLength(0);
  });

  test('multiple codes can coexist independently', () => {
    const { store } = makeStore();
    const a = store.createCode({
      clientId: 'cli_a',
      redirectUri: 'http://a/cb',
      codeChallenge: 'cha',
      scope: 'sa',
    });
    const b = store.createCode({
      clientId: 'cli_b',
      redirectUri: 'http://b/cb',
      codeChallenge: 'chb',
      scope: 'sb',
    });
    expect(a.code).not.toBe(b.code);

    // Consuming one does not affect the other.
    expect(store.consumeCode(a.code)?.clientId).toBe('cli_a');
    expect(store.consumeCode(b.code)?.clientId).toBe('cli_b');
  });
});

/* ------------------------------------------------------------------ */
/* concurrency / mutex                                                */
/* ------------------------------------------------------------------ */

describe('OAuthStore — concurrent mutations', () => {
  test('100 parallel issueToken calls all succeed and persist exactly 100 tokens', async () => {
    const { store, saved } = makeStore();
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        store.issueToken({ clientId: `cli_${i}`, scope: 's' })
      )
    );
    expect(results).toHaveLength(100);
    expect(new Set(results.map((t) => t.token)).size).toBe(100);
    expect(store.listTokens()).toHaveLength(100);

    // The final saved snapshot has all 100 tokens.
    expect(saved.at(-1)?.tokens.length).toBe(100);
  });

  test('parallel issue + revoke do not leave the store inconsistent', async () => {
    const { store } = makeStore();
    const issued = await store.issueToken({ clientId: 'x', scope: 's' });

    await Promise.all([
      store.issueToken({ clientId: 'y', scope: 's' }),
      store.revokeToken(issued.token),
      store.issueToken({ clientId: 'z', scope: 's' }),
    ]);

    const tokens = store.listTokens();
    expect(tokens).toHaveLength(2);
    expect(tokens.find((t) => t.token === issued.token)).toBeUndefined();
  });

  test('save callback is invoked once per mutation, in order', async () => {
    const { store, saved } = makeStore();
    await store.registerClient({ redirectUris: ['x'] });
    await store.issueToken({ clientId: 'a', scope: 's' });
    await store.issueToken({ clientId: 'b', scope: 's' });
    expect(saved).toHaveLength(3);
    expect(saved[0].clients).toHaveLength(1);
    expect(saved[0].tokens).toHaveLength(0);
    expect(saved[1].tokens).toHaveLength(1);
    expect(saved[2].tokens).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* snapshot                                                           */
/* ------------------------------------------------------------------ */

describe('OAuthStore — snapshot', () => {
  test('snapshot returns the current persistable state', async () => {
    const { store } = makeStore();
    await store.registerClient({ redirectUris: ['x'] });
    await store.issueToken({ clientId: 'cli_x', scope: 's' });
    const snap = store.snapshot();
    expect(snap.clients).toHaveLength(1);
    expect(snap.tokens).toHaveLength(1);
  });

  test('snapshot returns copies, not references', async () => {
    const { store } = makeStore();
    await store.issueToken({ clientId: 'cli_x', scope: 's' });
    const snap = store.snapshot();
    snap.tokens.length = 0;
    expect(store.listTokens()).toHaveLength(1);
  });
});
