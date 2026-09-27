import type { PluginStore } from '../../src/daemon/plugin-store';
import type { SessionHost, SessionLogFields } from '../../src/plugins/types';
import type { BaileysApi, WaAuthState, WaSocket } from '../../src/plugins/whatsapp/types';

/**
 * A stand-in for Baileys: sockets the test drives by emitting the events
 * WhatsApp would, and that record what the session asked of them. No network.
 */
export class FakeSocket implements WaSocket {
  private readonly listeners = new Map<string, Array<(payload: any) => void>>();
  readonly ev = {
    on: (event: string, listener: (payload: any) => void) => {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    },
    removeAllListeners: (event: string) => { this.listeners.delete(event); },
  };
  user?: { id: string; name?: string };
  sent: Array<{ jid: string; text: string }> = [];
  receipts: Array<Array<{ remoteJid: string; id: string; participant?: string; fromMe: boolean }>> = [];
  /** Numbers WhatsApp knows, as digits; anything else is not on WhatsApp. */
  registered = new Map<string, string>();
  groups: Record<string, { id: string; subject: string }> = {};
  pairingCodes: string[] = [];
  resyncs = 0;
  loggedOut = false;
  ended = false;
  failSend = false;

  constructor(readonly auth: WaAuthState, readonly getMessage: (key: { id?: string | null }) => Promise<any>) {}

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  open(id = '33600000000:3@s.whatsapp.net'): void {
    this.user = { id };
    this.emit('connection.update', { connection: 'open' });
  }

  close(statusCode?: number): void {
    this.emit('connection.update', { connection: 'close', lastDisconnect: { error: statusCode === undefined ? undefined : { output: { statusCode } } } });
  }

  async sendMessage(jid: string, content: { text: string }) {
    if (this.failSend) throw new Error('socket dropped');
    this.sent.push({ jid, text: content.text });
    const n = this.sent.length;
    return { key: { id: `SENT${n}`, remoteJid: jid, fromMe: true }, message: { conversation: content.text }, messageTimestamp: 1_800_000_000 + n };
  }

  async onWhatsApp(...numbers: string[]) {
    return numbers.map((n) => (this.registered.has(n) ? { jid: this.registered.get(n)!, exists: true } : { jid: `${n}@s.whatsapp.net`, exists: false }));
  }

  async readMessages(keys: Array<{ remoteJid: string; id: string; participant?: string; fromMe: boolean }>) {
    this.receipts.push(keys);
  }

  async groupFetchAllParticipating() {
    return this.groups;
  }

  async requestPairingCode(phone: string) {
    this.pairingCodes.push(phone);
    return 'ABCD1234';
  }

  async resyncAppState() {
    this.resyncs++;
  }

  async logout() {
    this.loggedOut = true;
  }

  end(): void {
    this.ended = true;
  }
}

export class FakeBaileys implements BaileysApi {
  readonly sockets: FakeSocket[] = [];
  /** Groups every new socket reports, like WhatsApp would after connecting. */
  groups: Record<string, { id: string; subject: string }> = {};

  get last(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }

  makeSocket(options: { auth: WaAuthState; getMessage: (key: { id?: string | null }) => Promise<any> }): FakeSocket {
    const socket = new FakeSocket(options.auth, options.getMessage);
    socket.groups = this.groups;
    this.sockets.push(socket);
    return socket;
  }

  initAuthCreds() {
    return { noiseKey: { private: 'n' }, registered: false };
  }

  toJson(value: unknown) {
    return JSON.parse(JSON.stringify(value));
  }

  fromJson(value: unknown) {
    return JSON.parse(JSON.stringify(value));
  }

  appStateSyncKey(value: unknown) {
    return { proto: value };
  }
}

/** A store in memory, with the JSON round-trip the real one does. */
export function memoryStore(): PluginStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      const raw = data.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    async set(key, value) {
      if (value === undefined) data.delete(key);
      else data.set(key, JSON.stringify(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, value: JSON.parse(data.get(key)!) }));
    },
  };
}

export function fakeHost(store: PluginStore = memoryStore()): SessionHost & { logs: SessionLogFields[] } {
  const logs: SessionLogFields[] = [];
  return { store, logs, log: (fields) => { logs.push(fields); } };
}

/** Wait until `check` holds, however slow the machine; fail with `what` after `timeoutMs`. */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

/** Let queued store writes and timers run. */
export const tick = (ms = 5) => Bun.sleep(ms);
