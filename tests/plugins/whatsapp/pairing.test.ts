import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { WhatsAppSession, whatsappSessions } from '../../../src/plugins/whatsapp/session';
import { CREDS_KEY } from '../../../src/plugins/whatsapp/records';
import type { Pairing } from '../../../src/plugins/types';
import { defineServicePlugin } from '../../../src/plugins/types';
import { FakeBaileys, fakeHost, memoryStore, tick } from '../../helpers/fake-baileys';
import { withTempVault } from '../../helpers/vault';
import { lockVault, unlockVault } from '../../../src/vault/vault';
import { readPointer } from '../../../src/vault/pointer';
import { getCredentials } from '../../../src/auth/token-store';
import { issueLocalToken } from '../../../src/auth/api-keys';
import { activatePluginRegistry, DEFAULT_PLUGIN_REGISTRY, SERVICE_PLUGINS } from '../../../src/plugins/registry';
import { PluginRegistry } from '../../../src/plugins/plugin-registry';
import { startSessions, stopSessions } from '../../../src/daemon/sessions';
import { createRequestHandler } from '../../../src/daemon/api';
import { v1KeyLimiter } from '../../../src/daemon/routes-v1';

const ME = '33600000000:5@s.whatsapp.net';

/** What a scan does: WhatsApp links the device, writes its identity, then asks for a fresh connection. */
function scan(api: FakeBaileys, id = ME): void {
  const socket = api.last;
  socket.auth.creds.me = { id };
  socket.emit('creds.update', { me: { id } });
  socket.close(515);
  api.last.open(id);
}

async function pairing(phone?: string) {
  const api = new FakeBaileys();
  const host = fakeHost();
  const pair = await WhatsAppSession.pair(api, host, { backoffMs: 1, phone });
  return { api, host, pair };
}

const outcome = async (pair: Pairing) => {
  const result = await pair.done;
  return result ? { paired: true, account: result.account } : { paired: false };
};

describe('pairing with a QR code', () => {
  test('each QR code WhatsApp rotates in is what the pairing shows', async () => {
    const { api, pair } = await pairing();
    expect(pair.status()).toEqual({ state: 'waiting' });
    api.last.emit('connection.update', { qr: 'QR-1' });
    expect(pair.status()).toEqual({ state: 'waiting', qr: 'QR-1' });
    api.last.emit('connection.update', { qr: 'QR-2' });
    expect(pair.status()).toEqual({ state: 'waiting', qr: 'QR-2' });
  });

  test('a scan links the account, and the pairing becomes the running session', async () => {
    const { api, host, pair } = await pairing();
    api.last.emit('connection.update', { qr: 'QR-1' });
    scan(api);
    expect(await outcome(pair)).toEqual({ paired: true, account: '+33600000000' });
    expect(pair.status()).toEqual({ state: 'paired', account: '+33600000000' });
    const session = (await pair.done)!.session;
    expect(session.status()).toEqual({ state: 'open', account: '+33600000000' });
    await tick();
    // The linked identity is in the store, so the next start connects without pairing.
    expect((await host.store.get<any>(CREDS_KEY)).me).toEqual({ id: ME });
    const again = new FakeBaileys();
    expect((await WhatsAppSession.start(again, fakeHost(host.store))).status().state).toBe('connecting');
    // And the history sync that follows a link lands in the store.
    api.last.emit('messaging-history.set', { chats: [{ id: '33611111111@s.whatsapp.net', unreadCount: 1, conversationTimestamp: 9 }], contacts: [], messages: [] });
    await tick();
    expect(await session.handle({ operation: 'conversations', params: {}, readOnly: false })).toHaveLength(1);
  });

  test('the store holds credentials from the first moment, before any scan', async () => {
    const { host } = await pairing();
    expect(await host.store.get(CREDS_KEY)).toEqual({ noiseKey: { private: 'n' }, registered: false });
  });

  test('QR codes that run out expire the pairing', async () => {
    const { api, pair } = await pairing();
    api.last.emit('connection.update', { qr: 'QR-1' });
    api.last.close(408);
    expect(await outcome(pair)).toEqual({ paired: false });
    expect(pair.status()).toEqual({ state: 'expired' });
    await tick(10);
    expect(api.sockets).toHaveLength(1);
  });

  test.each([[401, 'logged this device out'], [440, 'opened by another client'], [500, 'closed (500)']])(
    'a close with %d before the link is an error, not a retry', async (code, message) => {
      const { api, pair } = await pairing();
      api.last.close(code);
      expect(await outcome(pair)).toEqual({ paired: false });
      expect(pair.status()).toMatchObject({ state: 'error', message: expect.stringContaining(message) });
      await tick(10);
      expect(api.sockets).toHaveLength(1);
    },
  );

  test('cancelling ends the pairing and closes its socket', async () => {
    const { api, pair } = await pairing();
    api.last.emit('connection.update', { qr: 'QR-1' });
    await pair.cancel();
    expect(await outcome(pair)).toEqual({ paired: false });
    expect(pair.status()).toEqual({ state: 'error', message: 'pairing was cancelled' });
    expect(api.last.ended).toBe(true);
    // A late scan on the cancelled socket changes nothing.
    api.last.emit('connection.update', { connection: 'open' });
    expect(pair.status().state).toBe('error');
  });

  test('the QR code never reaches the session log', async () => {
    const { api, host, pair } = await pairing();
    api.last.emit('connection.update', { qr: 'QR-SECRET' });
    scan(api);
    await pair.done;
    expect(JSON.stringify(host.logs)).not.toContain('QR-SECRET');
  });
});

describe('pairing with a code', () => {
  test('a pairing code is asked for once the socket is ready, and replaces the QR codes', async () => {
    const { api, pair } = await pairing('33612345678');
    expect(api.last.pairingCodes).toEqual([]);
    api.last.emit('connection.update', { qr: 'QR-1' });
    await tick();
    expect(api.last.pairingCodes).toEqual(['33612345678']);
    expect(pair.status()).toEqual({ state: 'waiting', code: 'ABCD1234' });
    api.last.emit('connection.update', { qr: 'QR-2' });
    await tick();
    expect(api.last.pairingCodes).toEqual(['33612345678']);
    expect(pair.status()).toEqual({ state: 'waiting', code: 'ABCD1234' });
    scan(api);
    expect(await outcome(pair)).toEqual({ paired: true, account: '+33600000000' });
  });

  test('a refused pairing code ends the pairing with WhatsApp\'s reason', async () => {
    const { api, pair } = await pairing('33612345678');
    api.last.requestPairingCode = async () => { throw new Error('rate-overlimit'); };
    api.last.emit('connection.update', { qr: 'QR-1' });
    expect(await outcome(pair)).toEqual({ paired: false });
    expect(pair.status()).toMatchObject({ state: 'error', message: expect.stringContaining('rate-overlimit') });
  });
});

describe('pairing through the daemon', () => {
  const PASSPHRASE = 'whatsapp-pairing-passphrase';
  let api = new FakeBaileys();
  const whatsapp = defineServicePlugin()({
    apiVersion: 1,
    id: 'whatsapp',
    displayName: 'WhatsApp',
    description: 'test',
    registerCommands: () => {},
    session: whatsappSessions(async () => api, { backoffMs: 1 }),
  });
  const handle = createRequestHandler({ version: 'test' });
  const peer = { requestIP: () => ({ address: '10.0.0.8' }) };
  let token = '';
  const call = (path: string, method = 'GET', body?: unknown) =>
    handle(new Request(`http://hub${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), peer);

  afterEach(async () => {
    await stopSessions();
    activatePluginRegistry(DEFAULT_PLUGIN_REGISTRY);
  });
  withTempVault('agentio-whatsapp-pairing-', () => ({ passphrase: PASSPHRASE }));
  beforeEach(async () => {
    api = new FakeBaileys();
    activatePluginRegistry(new PluginRegistry([...SERVICE_PLUGINS, whatsapp]));
    delete process.env.AGENTIO_PASSPHRASE;
    lockVault();
    await unlockVault(PASSPHRASE);
    v1KeyLimiter.reset();
    token = issueLocalToken();
    await startSessions();
  });

  test('pair, scan, then send: the profile is recorded with only its store key and number', async () => {
    const started = await call('/v1/sessions/whatsapp/work/pair', 'POST', {});
    expect(started.status).toBe(202);
    api.last.emit('connection.update', { qr: 'QR-1' });
    expect(await (await call('/v1/sessions/whatsapp/work/pair')).json()).toEqual({ state: 'waiting', qr: 'QR-1' });

    scan(api);
    await tick(20);
    expect(await (await call('/v1/sessions/whatsapp/work/pair')).json()).toEqual({ state: 'paired', account: '+33600000000' });
    const credentials = await getCredentials<Record<string, unknown>>('whatsapp', 'work');
    expect(Object.keys(credentials!).sort()).toEqual(['account', 'storeKey']);
    expect(await (await call('/v1/sessions/whatsapp/work')).json()).toEqual({ state: 'open', account: '+33600000000', readOnly: false });

    api.last.registered.set('33611111111', '33611111111@s.whatsapp.net');
    const sent = await call('/v1/sessions/whatsapp/work/send', 'POST', { to: '+33611111111', text: 'Hello' });
    expect(sent.status).toBe(200);
    expect(api.last.sent).toEqual([{ jid: '33611111111@s.whatsapp.net', text: 'Hello' }]);
  });

  test('messages arriving are not a vault write', async () => {
    await call('/v1/sessions/whatsapp/work/pair', 'POST', {});
    scan(api);
    await tick(20);
    const path = (await readPointer())!;
    const before = Bun.file(path).lastModified;
    await Bun.sleep(15);
    api.last.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '33611111111@s.whatsapp.net', id: 'x', fromMe: false }, message: { conversation: 'hi' }, messageTimestamp: 5 }] });
    api.last.emit('creds.update', { signedPreKey: { keyId: 2 } });
    await tick(20);
    expect(Bun.file(path).lastModified).toBe(before);
    const read = await call('/v1/sessions/whatsapp/work/read', 'POST', { chat: '+33611111111', receipts: false });
    expect((await read.json()).messages).toHaveLength(1);
  });

  test('a restarted daemon reconnects the paired profile from its store', async () => {
    await call('/v1/sessions/whatsapp/work/pair', 'POST', {});
    scan(api);
    await tick(20);
    api.last.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '33611111111@s.whatsapp.net', id: 'x', fromMe: false }, message: { conversation: 'kept' }, messageTimestamp: 5 }] });
    await tick();
    await stopSessions();
    const sockets = api.sockets.length;
    await startSessions();
    expect(api.sockets.length).toBe(sockets + 1);
    const res = await call('/v1/sessions/whatsapp/work/conversations', 'POST', {});
    expect((await res.json()).map((c: { lastMessage: string }) => c.lastMessage)).toEqual(['kept']);
  });

  test('a pairing that expires records no profile', async () => {
    await call('/v1/sessions/whatsapp/work/pair', 'POST', {});
    api.last.close(408);
    await tick(20);
    expect(await (await call('/v1/sessions/whatsapp/work/pair')).json()).toEqual({ state: 'expired' });
    expect(await getCredentials('whatsapp', 'work')).toBeNull();
  });

  test('the daemon never logs the QR code', async () => {
    const log = spyOn(console, 'log');
    try {
      await call('/v1/sessions/whatsapp/work/pair', 'POST', {});
      api.last.emit('connection.update', { qr: 'QR-NEVER-LOGGED' });
      await call('/v1/sessions/whatsapp/work/pair');
      scan(api);
      await tick(20);
      expect(log.mock.calls.flat().join('\n')).not.toContain('QR-NEVER-LOGGED');
    } finally {
      log.mockRestore();
    }
  });
});
