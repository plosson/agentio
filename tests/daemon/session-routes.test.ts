import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync } from 'fs';
import { dirname } from 'path';
import { withTempVault } from '../helpers/vault';
import { lockVault, unlockVault } from '../../src/vault/vault';
import { saveProfile } from '../../src/config/profile-store';
import { getCredentials } from '../../src/auth/token-store';
import { createApiKey, issueLocalToken } from '../../src/auth/api-keys';
import { activatePluginRegistry, DEFAULT_PLUGIN_REGISTRY, SERVICE_PLUGINS } from '../../src/plugins/registry';
import { PluginRegistry } from '../../src/plugins/plugin-registry';
import {
  defineServicePlugin,
  type Pairing,
  type PairingStatus,
  type Session,
  type SessionHost,
  type SessionRequest,
  type SessionStatus,
} from '../../src/plugins/types';
import { createStore, openStore, storeDir, STORE_KEY_FIELD } from '../../src/daemon/plugin-store';
import { sessionStatus, startPairing, startSessions, stopSessions } from '../../src/daemon/sessions';
import { createRequestHandler } from '../../src/daemon/api';
import { v1AuthLimiter, v1KeyLimiter } from '../../src/daemon/routes-v1';

const PASSPHRASE = 'session-routes-passphrase';

let handled: SessionRequest[] = [];
let stops: string[] = [];
let pairFails = false;
/** The pairing the fake plugin handed out last, for the test to drive. */
let current: FakePairing | null = null;
let pairOptions: { phone?: string } | null = null;

class FakeSession implements Session {
  constructor(private readonly profile: string, private readonly host: SessionHost) {}
  status(): SessionStatus {
    return { state: 'open', account: `+${this.profile}` };
  }
  async handle(request: SessionRequest) {
    handled.push(request);
    return { profile: this.profile, generation: await this.host.store.get('generation') };
  }
  async stop(options?: { logout?: boolean }) {
    stops.push(`${this.profile}${options?.logout ? ':logout' : ''}`);
  }
}

class FakePairing implements Pairing {
  private state: PairingStatus = { state: 'waiting', qr: 'QR-SECRET-1' };
  private settle!: (result: { session: Session; account?: string } | null) => void;
  readonly done = new Promise<{ session: Session; account?: string } | null>((resolve) => { this.settle = resolve; });
  constructor(private readonly profile: string, private readonly host: SessionHost) {}
  status(): PairingStatus {
    return this.state;
  }
  rotate(qr: string) {
    this.state = { state: 'waiting', qr };
  }
  async link(account: string) {
    await this.host.store.set('generation', 'new');
    this.state = { state: 'paired', account };
    this.settle({ session: new FakeSession(this.profile, this.host), account });
  }
  expire() {
    this.state = { state: 'expired' };
    this.settle(null);
  }
  async cancel() {
    if (this.state.state === 'waiting') this.state = { state: 'error', message: 'closed' };
    this.settle(null);
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
      return new FakeSession(profile, host);
    },
    async pair(profile, options, host) {
      if (pairFails) throw new Error('cannot reach the service');
      pairOptions = options;
      current = new FakePairing(profile, host);
      return current;
    },
  },
});

const handle = createRequestHandler({ version: 'test' });
const peer = { requestIP: () => ({ address: '10.0.0.7' }) };
function call(path: string, token: string, init: { method?: string; body?: unknown; raw?: string } = {}): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (body !== undefined) headers.set('content-type', 'application/json');
  return handle(new Request(`http://hub${path}`, { method: init.method ?? 'GET', headers, body }), peer);
}

/** Let the pairing's settlement run through the supervisor's queue. */
const settled = () => Bun.sleep(20);

async function addPaired(name: string, generation: string): Promise<void> {
  const { key, store } = await createStore('fakechat', name);
  await store.set('generation', generation);
  store.close();
  await saveProfile('fakechat', name, { [STORE_KEY_FIELD]: key, account: `+${name}` });
}

let owner = '';
let manager = '';
let scoped = '';
let readOnlyKey = '';
let noManage = '';

// Registered before the vault helper's, so sessions stop while HOME is still the temp one.
afterEach(async () => {
  await stopSessions();
  await settled();
  activatePluginRegistry(DEFAULT_PLUGIN_REGISTRY);
});
withTempVault('agentio-session-routes-', () => ({
  passphrase: PASSPHRASE,
  config: { profiles: { fakechat: [{ name: 'ro', readOnly: true }], slack: [{ name: 'hook' }] } },
  credentials: { slack: { hook: { type: 'webhook', webhookUrl: 'https://hooks.slack.com/x' } } },
}));

beforeEach(async () => {
  handled = [];
  stops = [];
  pairFails = false;
  current = null;
  pairOptions = null;
  activatePluginRegistry(new PluginRegistry([...SERVICE_PLUGINS, fakechat]));
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  await unlockVault(PASSPHRASE);
  v1AuthLimiter.reset();
  v1KeyLimiter.reset();
  await addPaired('a', 'old');
  const { key: roKey, store } = await createStore('fakechat', 'ro');
  store.close();
  await saveProfile('fakechat', 'ro', { [STORE_KEY_FIELD]: roKey });
  owner = issueLocalToken();
  manager = (await createApiKey({ name: 'manager', allowedProfiles: '*', canManageProfiles: true }, 'https://hub')).token;
  scoped = (await createApiKey({ name: 'scoped', allowedProfiles: ['fakechat/ro'], canManageProfiles: true }, 'https://hub')).token;
  readOnlyKey = (await createApiKey({ name: 'reader', allowedProfiles: '*', readOnly: true }, 'https://hub')).token;
  noManage = (await createApiKey({ name: 'user', allowedProfiles: '*' }, 'https://hub')).token;
  await startSessions();
});



describe('session routes', () => {
  test('status reports the session and the caller\'s read-only flag', async () => {
    const res = await call('/v1/sessions/fakechat/a', manager);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'open', account: '+a', readOnly: false });
    expect(await (await call('/v1/sessions/fakechat/a', readOnlyKey)).json()).toMatchObject({ readOnly: true });
  });

  test('a profile outside the key is 403, an unknown one 404, a service without sessions 404', async () => {
    expect((await call('/v1/sessions/fakechat/a', scoped)).status).toBe(403);
    expect((await call('/v1/sessions/fakechat/nobody', manager)).status).toBe(404);
    expect((await call('/v1/sessions/slack/hook', manager)).status).toBe(404);
    expect((await call('/v1/sessions/slack/hook/send', manager, { method: 'POST', body: {} })).status).toBe(404);
  });

  test('no token is 401 and a locked vault is 503, before the session is asked anything', async () => {
    expect((await call('/v1/sessions/fakechat/a/echo', 'nope', { method: 'POST', body: {} })).status).toBe(401);
    lockVault();
    expect((await call('/v1/sessions/fakechat/a/echo', owner, { method: 'POST', body: {} })).status).toBe(503);
    expect(handled).toEqual([]);
  });

  test('an operation reaches the session with its parameters and the read-only flag', async () => {
    const res = await call('/v1/sessions/fakechat/a/echo', manager, { method: 'POST', body: { x: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: 'a', generation: 'old' });
    expect(handled).toEqual([{ operation: 'echo', params: { x: 1 }, readOnly: false }]);
  });

  test('an empty body is no parameters; a body that is not a JSON object is 400', async () => {
    expect((await call('/v1/sessions/fakechat/a/echo', manager, { method: 'POST' })).status).toBe(200);
    for (const raw of ['not json', '[1]', 'null', '"text"']) {
      expect((await call('/v1/sessions/fakechat/a/echo', manager, { method: 'POST', raw })).status).toBe(400);
    }
    expect(handled).toEqual([{ operation: 'echo', params: {}, readOnly: false }]);
  });

  test('a write is refused on a read-only profile and for a read-only key, and the session never sees it', async () => {
    await addPaired('ro', 'x');
    await startSessions();
    const byProfile = await call('/v1/sessions/fakechat/ro/send', manager, { method: 'POST', body: { to: 'x', text: 'y' } });
    expect(byProfile.status).toBe(403);
    const byKey = await call('/v1/sessions/fakechat/a/send', readOnlyKey, { method: 'POST', body: { to: 'x', text: 'y' } });
    expect(byKey.status).toBe(403);
    expect(await byKey.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(handled).toEqual([]);
  });

  test('a read on a read-only profile goes through, told it is read-only', async () => {
    await call('/v1/sessions/fakechat/a/read', readOnlyKey, { method: 'POST', body: {} });
    expect(handled).toEqual([{ operation: 'read', params: {}, readOnly: true }]);
  });

  test('a profile needing pairing is 409 with the command that fixes it', async () => {
    await saveProfile('fakechat', 'lost', { [STORE_KEY_FIELD]: (await createStore('fakechat', 'elsewhere')).key });
    await startSessions();
    const res = await call('/v1/sessions/fakechat/lost/echo', manager, { method: 'POST', body: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'AUTH_EXPIRED', suggestion: 'Run: agentio fakechat profile add --profile lost' });
  });

  test('a session profile\'s credentials never leave the daemon, not even to the owner', async () => {
    for (const token of [owner, manager]) {
      const res = await call('/v1/profiles/fakechat/a/credentials', token, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(STORE_KEY_FIELD);
    }
  });

  test('a session profile cannot be written with credentials; it is added by pairing', async () => {
    const res = await call('/v1/profiles/fakechat/new', manager, { method: 'PUT', body: { credentials: { [STORE_KEY_FIELD]: 'x' } } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ suggestion: 'Run: agentio fakechat profile add --profile new' });
    expect(await getCredentials('fakechat', 'new')).toBeNull();
  });

  test('removing a profile over /v1 logs it out and deletes its store', async () => {
    expect((await call('/v1/profiles/fakechat/a', manager, { method: 'DELETE' })).status).toBe(204);
    expect(stops).toEqual(['a:logout']);
    expect(existsSync(await storeDir('fakechat', 'a'))).toBe(false);
  });

  test('renaming a profile over /v1 restarts its session under the new name, with its store', async () => {
    expect((await call('/v1/profiles/fakechat/a', owner, { method: 'PATCH', body: { name: 'b' } })).status).toBe(200);
    expect(stops).toEqual(['a']);
    const res = await call('/v1/sessions/fakechat/b/echo', owner, { method: 'POST', body: {} });
    expect(await res.json()).toEqual({ profile: 'b', generation: 'old' });
  });
});

describe('pairing', () => {
  const start = (token: string, name: string, body: unknown = {}) => call(`/v1/sessions/fakechat/${name}/pair`, token, { method: 'POST', body });
  const poll = async (token: string, name: string) => {
    const res = await call(`/v1/sessions/fakechat/${name}/pair`, token);
    return { status: res.status, body: await res.json() };
  };

  test('a new profile: the QR code rotates, then the link is recorded and its session runs', async () => {
    const started = await start(manager, 'new');
    expect(started.status).toBe(202);
    expect((await poll(manager, 'new')).body).toEqual({ state: 'waiting', qr: 'QR-SECRET-1' });
    current!.rotate('QR-SECRET-2');
    expect((await poll(manager, 'new')).body).toEqual({ state: 'waiting', qr: 'QR-SECRET-2' });

    await current!.link('+33600000001');
    await settled();
    expect((await poll(manager, 'new')).body).toEqual({ state: 'paired', account: '+33600000001' });
    const credentials = await getCredentials<Record<string, string>>('fakechat', 'new');
    expect(credentials).toMatchObject({ account: '+33600000001' });
    // The store the pairing wrote to is the one the vault's key opens.
    const store = await openStore('fakechat', 'new', credentials![STORE_KEY_FIELD]);
    expect(await store.get('generation')).toBe('new');
    store.close();
    expect(sessionStatus('fakechat', 'new').state).toBe('open');
  });

  test('the QR code never reaches the daemon log', async () => {
    const log = spyOn(console, 'log');
    try {
      await start(manager, 'new');
      await poll(manager, 'new');
      await current!.link('+33600000001');
      await settled();
      expect(log.mock.calls.flat().join('\n')).not.toContain('QR-SECRET');
    } finally {
      log.mockRestore();
    }
  });

  test('pairing needs the managing right', async () => {
    expect((await start(noManage, 'new')).status).toBe(403);
    expect((await start(readOnlyKey, 'new')).status).toBe(403);
    expect(current).toBeNull();
  });

  test('an existing profile outside the key cannot be paired again; a new name can, and the key gains it', async () => {
    expect((await start(scoped, 'a')).status).toBe(403);
    expect(current).toBeNull();
    expect((await start(scoped, 'fresh')).status).toBe(202);
    await current!.link('+1');
    await settled();
    expect((await call('/v1/sessions/fakechat/fresh', scoped)).status).toBe(200);
  });

  test('only the key that started a pairing can read its QR code or cancel it', async () => {
    await start(manager, 'new');
    expect((await poll(owner, 'new')).status).toBe(404);
    expect((await call('/v1/sessions/fakechat/new/pair', owner, { method: 'DELETE' })).status).toBe(404);
    expect((await poll(manager, 'new')).status).toBe(200);
  });

  test('a second pairing for the same profile is refused while one runs', async () => {
    await start(manager, 'new');
    const again = await start(owner, 'new');
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: expect.stringContaining('already in progress') });
  });

  test('an expired pairing records nothing and leaves no store behind', async () => {
    await start(manager, 'new');
    current!.expire();
    await settled();
    expect((await poll(manager, 'new')).body).toEqual({ state: 'expired' });
    expect(await getCredentials('fakechat', 'new')).toBeNull();
    expect(existsSync(await storeDir('fakechat', 'new'))).toBe(false);
  });

  test('a pairing nobody finishes times out as expired', async () => {
    await startPairing('fakechat', 'slow', { keyId: 'local', timeoutMs: 10 });
    await Bun.sleep(40);
    expect((await poll(owner, 'slow')).body).toEqual({ state: 'expired' });
  });

  test('a cancelled pairing ends as an error and records nothing', async () => {
    await start(manager, 'new');
    expect((await call('/v1/sessions/fakechat/new/pair', manager, { method: 'DELETE' })).status).toBe(204);
    await settled();
    expect((await poll(manager, 'new')).body).toMatchObject({ state: 'error' });
    expect(await getCredentials('fakechat', 'new')).toBeNull();
  });

  test('pairing an existing profile again replaces its store and key when it succeeds', async () => {
    const before = await getCredentials<Record<string, string>>('fakechat', 'a');
    await start(owner, 'a');
    // The old session stops while the new account is linked.
    expect(stops).toEqual(['a']);
    await current!.link('+33600000002');
    await settled();
    const after = await getCredentials<Record<string, string>>('fakechat', 'a');
    expect(after![STORE_KEY_FIELD]).not.toBe(before![STORE_KEY_FIELD]);
    const res = await call('/v1/sessions/fakechat/a/echo', owner, { method: 'POST', body: {} });
    expect(await res.json()).toEqual({ profile: 'a', generation: 'new' });
    // Nothing set aside is left over.
    expect(readdirSync(dirname(await storeDir('fakechat', 'a'))).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  test('pairing an existing profile again that fails gives it back its old store and session', async () => {
    await start(owner, 'a');
    current!.expire();
    await settled();
    const res = await call('/v1/sessions/fakechat/a/echo', owner, { method: 'POST', body: {} });
    expect(await res.json()).toEqual({ profile: 'a', generation: 'old' });
    expect(await getCredentials('fakechat', 'a')).toMatchObject({ account: '+a' });
  });

  test('locking the vault mid-pairing ends it, records nothing, and restores the old store', async () => {
    await start(owner, 'a');
    await stopSessions();
    await settled();
    await unlockVault(PASSPHRASE);
    await startSessions();
    const res = await call('/v1/sessions/fakechat/a/echo', owner, { method: 'POST', body: {} });
    expect(await res.json()).toEqual({ profile: 'a', generation: 'old' });
  });

  test('a link that lands once the vault is locked is logged out rather than kept', async () => {
    await start(owner, 'new');
    lockVault();
    await current!.link('+1');
    await settled();
    expect(stops).toEqual(['new:logout']);
    await stopSessions();
    await unlockVault(PASSPHRASE);
    expect(await getCredentials('fakechat', 'new')).toBeNull();
    expect(existsSync(await storeDir('fakechat', 'new'))).toBe(false);
  });

  test('removing a profile mid-pairing leaves nothing of it', async () => {
    await start(owner, 'a');
    expect((await call('/v1/profiles/fakechat/a', owner, { method: 'DELETE' })).status).toBe(204);
    await settled();
    expect(existsSync(await storeDir('fakechat', 'a'))).toBe(false);
    expect(readdirSync(dirname(await storeDir('fakechat', 'a'))).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  test('a pairing that cannot start leaves the old store and session as they were', async () => {
    pairFails = true;
    expect((await start(owner, 'a')).status).toBe(500);
    const res = await call('/v1/sessions/fakechat/a/echo', owner, { method: 'POST', body: {} });
    expect(await res.json()).toEqual({ profile: 'a', generation: 'old' });
  });

  test('a phone number is checked and passed on as digits', async () => {
    for (const phone of ['abc', '+0612345678', '12', 42, '+33 6 12 34 56 78 99 99 99']) {
      expect((await start(owner, 'new', { phone })).status).toBe(400);
    }
    expect((await start(owner, 'new', { phone: '+33 6 12-34-56-78' })).status).toBe(202);
    expect(pairOptions).toEqual({ phone: '33612345678' });
  });

  test('a name that is not one path segment is refused before anything is paired', async () => {
    expect((await start(owner, 'a%2Fb')).status).toBe(400);
    expect((await start(owner, '%20')).status).toBe(400);
    expect(current).toBeNull();
  });

  test('a pairing asked for read-only records a read-only profile', async () => {
    expect((await start(owner, 'new', { readOnly: true })).status).toBe(202);
    await current!.link('+1');
    await settled();
    expect(await (await call('/v1/sessions/fakechat/new', owner)).json()).toMatchObject({ readOnly: true });
    expect((await start(owner, 'other', { readOnly: 'yes' })).status).toBe(400);
  });

  test('polling a profile nobody is pairing is 404', async () => {
    expect((await poll(owner, 'a')).status).toBe(404);
  });
});
