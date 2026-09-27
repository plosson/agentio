import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { withTempVault } from '../helpers/vault';
import { lockVault, unlockVault } from '../../src/vault/vault';
import { deleteProfile, saveProfile } from '../../src/config/profile-store';
import { activatePluginRegistry, DEFAULT_PLUGIN_REGISTRY, SERVICE_PLUGINS } from '../../src/plugins/registry';
import { PluginRegistry } from '../../src/plugins/plugin-registry';
import { defineServicePlugin, type Session, type SessionHost, type SessionStatus } from '../../src/plugins/types';
import { createStore, openStore, storeDir, STORE_KEY_FIELD } from '../../src/daemon/plugin-store';
import {
  reconcileSessions,
  requireSession,
  sessionProfileRemoved,
  sessionProfileRenamed,
  sessionsActive,
  sessionStatus,
  startSessions,
  stopSessions,
} from '../../src/daemon/sessions';
import { createRequestHandler } from '../../src/daemon/api';
import { unlockLimiter } from '../../src/daemon/routes-ui';
import { stopKeepalive } from '../../src/daemon/keepalive';

const PASSPHRASE = 'sessions-passphrase-123';

/** Everything the fake plugin was asked to do, in order. */
let calls: string[] = [];
/** Profiles whose start throws. */
let failing = new Set<string>();
/** When set, start waits for it, so a test can land a lock mid-start. */
let gate: Promise<void> | null = null;
/** Profiles whose stop throws. */
let badStop = new Set<string>();

class FakeSession implements Session {
  stopped = false;
  constructor(private readonly profile: string, private readonly host: SessionHost) {}
  status(): SessionStatus {
    return this.stopped ? { state: 'closed' } : { state: 'open', account: `+${this.profile}` };
  }
  async handle() {
    return { profile: this.profile, seen: await this.host.store.get('seen') };
  }
  async stop(options?: { logout?: boolean }) {
    calls.push(`stop:${this.profile}${options?.logout ? ':logout' : ''}`);
    // The last state goes to the store before the daemon closes it.
    await this.host.store.set('last', `written by ${this.profile}`);
    this.stopped = true;
    if (badStop.has(this.profile)) throw new Error('stop blew up');
  }
}

const fakechat = defineServicePlugin()({
  apiVersion: 1,
  id: 'fakechat',
  displayName: 'Fake chat',
  description: 'A session plugin for tests.',
  registerCommands: () => {},
  session: {
    writeOperations: ['send'],
    async start(profile, host) {
      calls.push(`start:${profile}`);
      if (gate) await gate;
      if (failing.has(profile)) throw new Error('cannot connect');
      return new FakeSession(profile, host);
    },
    async pair() {
      throw new Error('not used here');
    },
  },
});

/** A profile with a store, the way pairing leaves one. */
async function addPaired(name: string, seed: Record<string, unknown> = {}): Promise<string> {
  const { key, store } = await createStore('fakechat', name);
  for (const [k, v] of Object.entries(seed)) await store.set(k, v);
  store.close();
  await saveProfile('fakechat', name, { [STORE_KEY_FIELD]: key });
  return key;
}

withTempVault('agentio-sessions-test-', () => ({
  passphrase: PASSPHRASE,
  config: { profiles: { slack: [{ name: 'hook' }] } },
  credentials: { slack: { hook: { type: 'webhook', webhookUrl: 'https://hooks.slack.com/x' } } },
}));

beforeEach(async () => {
  calls = [];
  failing = new Set();
  badStop = new Set();
  gate = null;
  unlockLimiter.reset();
  activatePluginRegistry(new PluginRegistry([...SERVICE_PLUGINS, fakechat]));
  // Daemon posture: the resident passphrase, not the env var.
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  await unlockVault(PASSPHRASE);
});

afterEach(async () => {
  stopKeepalive();
  await stopSessions();
  activatePluginRegistry(DEFAULT_PLUGIN_REGISTRY);
});

describe('session supervisor', () => {
  test('nothing runs until the vault is unlocked and sessions are started', async () => {
    await addPaired('a');
    await reconcileSessions();
    expect(calls).toEqual([]);
    expect(sessionsActive()).toBe(false);
    expect(sessionStatus('fakechat', 'a').state).toBe('closed');
    expect(() => requireSession('fakechat', 'a')).toThrow('No fakechat session');
  });

  test('starting opens one session per profile of every session plugin, and only those', async () => {
    await addPaired('a');
    await addPaired('b');
    await startSessions();
    expect(calls.sort()).toEqual(['start:a', 'start:b']);
    expect(sessionStatus('fakechat', 'a')).toEqual({ state: 'open', account: '+a' });
    // A plugin without `session` is never asked.
    expect(sessionStatus('slack', 'hook').state).toBe('closed');
  });

  test('starting twice does not open a second session for the same profile', async () => {
    await addPaired('a');
    await startSessions();
    await startSessions();
    await reconcileSessions();
    expect(calls).toEqual(['start:a']);
  });

  test('a profile whose store is missing needs pairing, and the others still start', async () => {
    await addPaired('a');
    await saveProfile('fakechat', 'lost', { [STORE_KEY_FIELD]: (await createStore('fakechat', 'elsewhere')).key });
    await startSessions();
    expect(sessionStatus('fakechat', 'lost')).toMatchObject({ state: 'needs_pairing' });
    expect(calls).toEqual(['start:a']);
    expect(() => requireSession('fakechat', 'lost')).toThrow(expect.objectContaining({
      code: 'AUTH_EXPIRED',
      suggestion: 'Run: agentio fakechat profile add --profile lost',
    }));
  });

  test('a store whose key does not match needs pairing; the plugin never sees it', async () => {
    await addPaired('a');
    const other = await createStore('fakechat', 'b');
    other.store.close();
    await saveProfile('fakechat', 'b', { [STORE_KEY_FIELD]: (await createStore('fakechat', 'unrelated')).key });
    await startSessions();
    expect(sessionStatus('fakechat', 'b')).toMatchObject({ state: 'needs_pairing', detail: 'the store does not match its key' });
    expect(calls).toEqual(['start:a']);
  });

  test('a start that throws leaves the profile closed with the reason, without stopping the rest', async () => {
    await addPaired('a');
    await addPaired('b');
    failing.add('a');
    await startSessions();
    expect(sessionStatus('fakechat', 'a')).toEqual({ state: 'closed', detail: 'cannot connect' });
    expect(sessionStatus('fakechat', 'b').state).toBe('open');
    // Its store was closed again, so it can be opened afresh.
    const credentials = (await import('../../src/auth/token-store')).getCredentials;
    const key = (await credentials<Record<string, string>>('fakechat', 'a'))![STORE_KEY_FIELD];
    (await openStore('fakechat', 'a', key)).close();
  });

  test('stopping lets every session write its state before its store closes', async () => {
    const key = await addPaired('a');
    await startSessions();
    await stopSessions();
    expect(calls).toEqual(['start:a', 'stop:a']);
    expect(sessionsActive()).toBe(false);
    expect(() => requireSession('fakechat', 'a')).toThrow();
    const store = await openStore('fakechat', 'a', key);
    expect(await store.get('last')).toBe('written by a');
    store.close();
  });

  test('a stop that throws still closes the store and forgets the session', async () => {
    await addPaired('a');
    await addPaired('b');
    badStop.add('a');
    await startSessions();
    await stopSessions();
    expect(calls.filter((c) => c.startsWith('stop'))).toEqual(['stop:a', 'stop:b']);
    expect(sessionStatus('fakechat', 'a').state).toBe('closed');
  });

  test('a lock that lands while a session is starting leaves nothing running', async () => {
    await addPaired('a');
    await addPaired('b');
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    const starting = startSessions();
    await Bun.sleep(5);
    const stopping = stopSessions();
    release();
    await Promise.all([starting, stopping]);
    // `a` got as far as the plugin and was then stopped; `b` never started.
    expect(calls).toEqual(['start:a', 'stop:a']);
    expect(sessionStatus('fakechat', 'a').state).toBe('closed');
    expect(sessionStatus('fakechat', 'b').state).toBe('closed');
  });

  test('reconciling starts an added profile and stops a removed one, without logging it out', async () => {
    await addPaired('a');
    await startSessions();
    await addPaired('b');
    await reconcileSessions();
    expect(sessionStatus('fakechat', 'b').state).toBe('open');
    await deleteProfile('fakechat', 'a');
    await reconcileSessions();
    expect(calls).toEqual(['start:a', 'start:b', 'stop:a']);
  });

  test('a rename stops the session, moves its store, and starts it under the new name with its data', async () => {
    const key = await addPaired('a', { seen: 42 });
    await startSessions();
    const { renameProfile } = await import('../../src/config/profile-store');
    await renameProfile('fakechat', 'a', 'z');
    await sessionProfileRenamed('fakechat', 'a', 'z');
    expect(calls).toEqual(['start:a', 'stop:a', 'start:z']);
    expect(existsSync(await storeDir('fakechat', 'a'))).toBe(false);
    expect(await requireSession('fakechat', 'z').handle({ operation: 'x', params: {}, readOnly: false })).toEqual({ profile: 'z', seen: 42 });
    (await openStore('fakechat', 'z', key)).close();
  });

  test('a removal logs the account out and deletes the store', async () => {
    await addPaired('a');
    await startSessions();
    await deleteProfile('fakechat', 'a');
    await sessionProfileRemoved('fakechat', 'a');
    expect(calls).toEqual(['start:a', 'stop:a:logout']);
    expect(existsSync(await storeDir('fakechat', 'a'))).toBe(false);
  });

  test('renaming or removing a profile of a plugin without sessions touches no store', async () => {
    await startSessions();
    await sessionProfileRenamed('slack', 'hook', 'other');
    await sessionProfileRemoved('slack', 'hook');
    expect(calls).toEqual([]);
  });

  test('with no session plugin registered, starting does nothing', async () => {
    activatePluginRegistry(DEFAULT_PLUGIN_REGISTRY);
    await startSessions();
    expect(calls).toEqual([]);
  });
});

describe('session supervisor through the admin UI', () => {
  const handle = createRequestHandler({ version: 'test' });
  const peer = { requestIP: () => ({ address: '10.0.0.9' }) };
  const call = (path: string, init: RequestInit = {}) => handle(new Request(`http://hub${path}`, init), peer);

  async function unlock(): Promise<string> {
    const res = await call('/ui/api/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }

  test('unlocking starts sessions and locking stops them', async () => {
    await addPaired('a');
    lockVault();
    const cookie = await unlock();
    expect(sessionStatus('fakechat', 'a').state).toBe('open');
    const res = await call('/ui/api/lock', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(204);
    expect(calls).toEqual(['start:a', 'stop:a']);
    expect(sessionsActive()).toBe(false);
  });

  test('a rename in the UI restarts the session under the new name', async () => {
    await addPaired('a');
    const cookie = await unlock();
    const res = await call('/ui/api/profiles/fakechat/a', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'b' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['start:a', 'stop:a', 'start:b']);
  });

  test('a rename the vault refuses leaves the session alone', async () => {
    await addPaired('a');
    await addPaired('b');
    const cookie = await unlock();
    const res = await call('/ui/api/profiles/fakechat/a', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'b' }),
    });
    expect(res.status).toBe(400);
    expect(calls.sort()).toEqual(['start:a', 'start:b']);
    expect(existsSync(await storeDir('fakechat', 'a'))).toBe(true);
  });

  test('a delete in the UI logs out, stops the session and deletes the store', async () => {
    await addPaired('a');
    const cookie = await unlock();
    const res = await call('/ui/api/profiles/fakechat/a', { method: 'DELETE', headers: { cookie } });
    expect(res.status).toBe(204);
    expect(calls).toEqual(['start:a', 'stop:a:logout']);
    expect(existsSync(await storeDir('fakechat', 'a'))).toBe(false);
  });
});
