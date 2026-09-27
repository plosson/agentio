import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'fs';
import type { Server } from 'bun';
import { withTempVault } from '../../helpers/vault';
import { FakeBaileys, tick } from '../../helpers/fake-baileys';
import { lockVault, unlockVault } from '../../../src/vault/vault';
import { setProfileReadOnly, listProfileRefs } from '../../../src/config/config-manager';
import { getCredentials } from '../../../src/auth/token-store';
import { issueLocalToken } from '../../../src/auth/api-keys';
import { encodeToken } from '../../../src/auth/token';
import { resetRemoteCache } from '../../../src/auth/remote';
import { activatePluginRegistry, DEFAULT_PLUGIN_REGISTRY, SERVICE_PLUGINS } from '../../../src/plugins/registry';
import { PluginRegistry } from '../../../src/plugins/plugin-registry';
import { defineServicePlugin } from '../../../src/plugins/types';
import { registerWhatsAppCommands } from '../../../src/plugins/whatsapp/commands';
import { whatsappSessions } from '../../../src/plugins/whatsapp/session';
import { pairWhatsAppProfile, PairingExpired } from '../../../src/plugins/whatsapp/commands';
import { WhatsAppClient } from '../../../src/plugins/whatsapp/client';
import { startSessions, stopSessions } from '../../../src/daemon/sessions';
import { createRequestHandler } from '../../../src/daemon/api';
import { v1KeyLimiter } from '../../../src/daemon/routes-v1';
import { daemonRecordPath, recordDaemon, sessionTarget } from '../../../src/daemon/client';
import { storeDir } from '../../../src/daemon/plugin-store';
import { removeProfileForService, renameProfileForService } from '../../../src/utils/profile-commands';
import { getProfileStatuses } from '../../../src/commands/status';
import { exitCodeForError } from '../../../src/utils/errors';

const PASSPHRASE = 'whatsapp-cli-passphrase';
const ME = '33600000000:5@s.whatsapp.net';

let api = new FakeBaileys();
const whatsapp = defineServicePlugin()({
  apiVersion: 1,
  id: 'whatsapp',
  displayName: 'WhatsApp',
  description: 'test',
  registerCommands: registerWhatsAppCommands,
  session: whatsappSessions(async () => api, { backoffMs: 1 }),
});

let server: Server<unknown> | null = null;
let url = '';

/** Wait until the fake has opened `count` sockets. */
async function sockets(count: number): Promise<void> {
  for (let i = 0; i < 200 && api.sockets.length < count; i++) await tick(2);
  if (api.sockets.length < count) throw new Error(`expected ${count} sockets, got ${api.sockets.length}`);
}

function scan(id = ME): void {
  const socket = api.last;
  socket.auth.creds.me = { id };
  socket.emit('creds.update', { me: { id } });
  socket.close(515);
  api.last.open(id);
}

/** What went to stdout through writes, which is where JSON events go. */
function captureStdout() {
  const lines: string[] = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { lines: () => lines.join('').split('\n').filter(Boolean), restore: () => spy.mockRestore() };
}

/**
 * Start pairing `work` through the CLI function against the running daemon.
 * The pairing comes back wrapped: returned bare from an async function, it
 * would be awaited to its end before the test could scan anything.
 */
async function pairWork(options: { json?: boolean; phone?: string; readOnly?: boolean } = {}) {
  const pairing = pairWhatsAppProfile({ profile: 'work', pollMs: 15, ...options });
  pairing.catch(() => {});
  await sockets(1);
  return { pairing };
}

afterEach(async () => {
  server?.stop(true);
  server = null;
  await stopSessions();
  activatePluginRegistry(DEFAULT_PLUGIN_REGISTRY);
  delete process.env.AGENTIO_TOKEN;
  resetRemoteCache();
});
withTempVault('agentio-whatsapp-cli-', () => ({ passphrase: PASSPHRASE }));
beforeEach(async () => {
  api = new FakeBaileys();
  activatePluginRegistry(new PluginRegistry([...SERVICE_PLUGINS.filter((p) => p.id !== 'whatsapp'), whatsapp]));
  // The daemon posture, in this process: the resident passphrase only.
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  await unlockVault(PASSPHRASE);
  v1KeyLimiter.reset();
  await startSessions();
  const handle = createRequestHandler({ version: 'test' });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request, srv) => handle(request, srv) });
  url = `http://127.0.0.1:${server.port}`;
  await recordDaemon({ url, pid: process.pid, token: issueLocalToken() });
});

describe('profile add', () => {
  test('--json prints one event per QR code, then paired, and nothing else', async () => {
    const out = captureStdout();
    try {
      const { pairing } = await pairWork({ json: true });
      api.last.emit('connection.update', { qr: 'QR-1' });
      await tick(20);
      api.last.emit('connection.update', { qr: 'QR-2' });
      await tick(20);
      scan();
      await pairing;
    } finally {
      out.restore();
    }
    expect(out.lines().map((l) => JSON.parse(l))).toEqual([
      { v: 1, event: 'qr', qr: 'QR-1' },
      { v: 1, event: 'qr', qr: 'QR-2' },
      { v: 1, event: 'paired', profile: 'work', number: '+33600000000' },
    ]);
    expect(await getCredentials('whatsapp', 'work')).toMatchObject({ account: '+33600000000' });
  });

  test('--json with --phone prints the pairing code once instead of QR codes', async () => {
    const out = captureStdout();
    try {
      const { pairing } = await pairWork({ json: true, phone: '+33 6 12 34 56 78' });
      api.last.emit('connection.update', { qr: 'QR-1' });
      await tick(20);
      api.last.emit('connection.update', { qr: 'QR-2' });
      await tick(20);
      scan();
      await pairing;
    } finally {
      out.restore();
    }
    expect(out.lines().map((l) => JSON.parse(l))).toEqual([
      { v: 1, event: 'code', code: 'ABCD-1234' },
      { v: 1, event: 'paired', profile: 'work', number: '+33600000000' },
    ]);
    expect(api.sockets[0]!.pairingCodes).toEqual(['33612345678']);
  });

  test('a pairing that expires fails as AUTH_FAILED, the exit code login --json uses', async () => {
    const out = captureStdout();
    let error: unknown;
    try {
      const { pairing } = await pairWork({ json: true });
      api.last.emit('connection.update', { qr: 'QR-1' });
      await tick(20);
      api.last.close(408);
      await pairing.catch((e) => { error = e; });
    } finally {
      out.restore();
    }
    expect(error).toBeInstanceOf(PairingExpired);
    expect(exitCodeForError((error as PairingExpired).code)).toBe(2);
    expect(out.lines().map((l) => JSON.parse(l).event)).toEqual(['qr']);
    expect(await getCredentials('whatsapp', 'work')).toBeNull();
  });

  test('a pairing WhatsApp refuses fails with its reason', async () => {
    const { pairing } = await pairWork();
    api.last.close(401);
    await expect(pairing).rejects.toMatchObject({ code: 'API_ERROR', message: expect.stringContaining('logged this device out') });
  });

  test('in a terminal, the QR code is drawn on stderr and only the result reaches stdout', async () => {
    const out = captureStdout();
    const log = spyOn(console, 'log');
    const err = spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    try {
      const { pairing } = await pairWork();
      api.last.emit('connection.update', { qr: 'QR-TEXT' });
      await tick(20);
      scan();
      await pairing;
      expect(err.mock.calls.flat().join('')).toContain('▄');
      // The daemon runs in this process too, so its own log lines are here as well; none carries the code.
      expect(log.mock.calls.flat()).toContain('Profile "work" paired with +33600000000');
      expect(log.mock.calls.flat().join('\n')).not.toContain('QR-TEXT');
      expect(out.lines()).toEqual([]);
    } finally {
      out.restore();
      log.mockRestore();
      err.mockRestore();
    }
  });

  test('a phone that is not a number is refused before the daemon is asked', async () => {
    await expect(pairWhatsAppProfile({ profile: 'work', phone: 'Alice' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(api.sockets).toHaveLength(0);
  });
});

describe('commands through the daemon', () => {
  async function paired(): Promise<WhatsAppClient> {
    const { pairing } = await pairWork();
    scan();
    await pairing;
    api.last.registered.set('33611111111', '33611111111@s.whatsapp.net');
    api.last.emit('contacts.upsert', [
      { id: '33611111111@s.whatsapp.net', name: 'Alice' },
      { id: '33622222222@s.whatsapp.net', name: 'Bob' },
      { id: '33633333333@s.whatsapp.net', name: 'Bob' },
      { id: '777@lid', notify: 'Ghost' },
    ]);
    api.last.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '33611111111@s.whatsapp.net', id: 'a1', fromMe: false }, message: { conversation: 'hi' }, messageTimestamp: 10 }] });
    await tick(10);
    return new WhatsAppClient('work');
  }

  test('status, conversations, send, read and contacts all go to the daemon with the local token', async () => {
    const client = await paired();
    expect(await client.status()).toEqual({ state: 'open', account: '+33600000000', readOnly: false });
    expect((await client.conversations({ unreadOnly: true })).map((c) => c.name)).toEqual(['Alice']);
    expect(await client.send('+33611111111', 'Hello')).toMatchObject({ to: '33611111111@s.whatsapp.net' });
    const read = await client.read('Alice', { last: 10, receipts: true });
    expect(read.messages.map((m) => m.text)).toEqual(['hi', 'Hello']);
    expect(read.receiptsSent).toBe(1);
    expect(await client.contacts('ghost')).toEqual([{ name: 'Ghost', jid: '777@lid', source: 'self' }]);
    // The CLI never opened a socket: the one the daemon paired is the only one.
    expect(api.sockets.every((s) => s !== undefined)).toBe(true);
    expect(api.sockets).toHaveLength(2);
  });

  test('an ambiguous or unknown name fails with the reason, and a number not on WhatsApp before sending', async () => {
    const client = await paired();
    await expect(client.send('bob', 'x')).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('several') });
    await expect(client.send('Carol', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(client.send('+33699999999', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND', message: '+33699999999 is not on WhatsApp' });
    expect(api.last.sent).toEqual([]);
  });

  test('a read-only profile cannot send and never sends read receipts', async () => {
    const client = await paired();
    await setProfileReadOnly('whatsapp', 'work', true);
    await expect(client.send('+33611111111', 'x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await client.read('Alice', { receipts: true })).receiptsSent).toBe(0);
    expect(api.last.sent).toEqual([]);
    expect(api.last.receipts).toEqual([]);
  });

  test('removing the profile goes through the daemon: logged out, store deleted, entry gone', async () => {
    await paired();
    const socket = api.last;
    await removeProfileForService('whatsapp', 'work');
    expect(socket.loggedOut).toBe(true);
    expect(existsSync(await storeDir('whatsapp', 'work'))).toBe(false);
    expect(await listProfileRefs()).toEqual([]);
  });

  test('renaming the profile goes through the daemon, which restarts its session under the new name', async () => {
    await paired();
    await renameProfileForService('whatsapp', 'work', 'job');
    await sockets(3);
    api.last.open(ME);
    await tick(10);
    expect(await new WhatsAppClient('job').status()).toMatchObject({ state: 'open' });
    expect((await new WhatsAppClient('job').conversations({})).map((c) => c.name)).toEqual(['Alice']);
  });

  test('agentio status reports the session, and a daemon that is down is that row\'s error only', async () => {
    await paired();
    expect((await getProfileStatuses()).find((s) => s.service === 'whatsapp')).toMatchObject({ status: 'ok', info: '+33600000000' });
    server!.stop(true);
    expect((await getProfileStatuses()).find((s) => s.service === 'whatsapp')).toMatchObject({ status: 'invalid', error: expect.stringContaining('not running') });
  });
});

describe('when the daemon cannot be used', () => {
  test('no daemon running is NETWORK_ERROR with the command that starts one, for every command', async () => {
    const client = new WhatsAppClient('work');
    for (const record of [null, { url, pid: Bun.spawnSync(['true']).pid, token: 't' }, { url, pid: process.pid }]) {
      if (record) await recordDaemon(record);
      else (await import('fs')).unlinkSync(daemonRecordPath());
      for (const call of [() => client.status(), () => client.conversations({}), () => client.send('+33611111111', 'x'), () => client.read('x', { receipts: false }), () => client.contacts()]) {
        await expect(call()).rejects.toMatchObject({ code: 'NETWORK_ERROR', suggestion: 'Run: agentio daemon start' });
      }
      await expect(pairWhatsAppProfile({ profile: 'work', json: true })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    }
  });

  test('a daemon recorded but not answering is NETWORK_ERROR too', async () => {
    server!.stop(true);
    await expect(new WhatsAppClient('work').status()).rejects.toMatchObject({ code: 'NETWORK_ERROR', suggestion: 'Run: agentio daemon start' });
  });

  test('a token the daemon does not know is refused, with the fix', async () => {
    await recordDaemon({ url, pid: process.pid, token: 'stale-token' });
    await expect(new WhatsAppClient('work').status()).rejects.toMatchObject({ code: 'AUTH_FAILED', suggestion: expect.stringContaining('daemon start') });
  });

  test('a locked vault on the daemon says so, with where to unlock it', async () => {
    lockVault();
    await expect(new WhatsAppClient('work').status()).rejects.toMatchObject({ code: 'VAULT_LOCKED', suggestion: `Unlock it at ${url}/ui` });
  });

  test('in remote mode, calls go to the hub with the key, never to a local daemon', async () => {
    process.env.AGENTIO_TOKEN = encodeToken({ url: 'https://hub.example', kid: 'abcdefgh', secret: 'x'.repeat(43) });
    resetRemoteCache();
    expect(sessionTarget()).toEqual({ url: 'https://hub.example', token: process.env.AGENTIO_TOKEN, remote: true });
  });
});
