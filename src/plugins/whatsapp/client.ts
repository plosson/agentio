import { daemonCall, daemonDownload } from '../../daemon/client';
import type { HubFile } from '../../auth/remote';
import type { ChatSummary, ContactView, PairState, ReadResult, SendResult, WhatsAppStatus } from './types';

/**
 * The CLI's WhatsApp client. It never opens a socket: every call goes to the
 * daemon that holds the profile's session, on this machine or on the hub.
 */

/** A download waits for WhatsApp's servers, and sometimes for the phone first; the daemon allows 255 seconds. */
const DOWNLOAD_TIMEOUT_MS = 255_000;

const route = (profile: string, action?: string) =>
  `/v1/sessions/whatsapp/${encodeURIComponent(profile)}${action ? `/${action}` : ''}`;

export class WhatsAppClient {
  constructor(readonly profile: string) {}

  status(): Promise<WhatsAppStatus> {
    return daemonCall(route(this.profile));
  }

  conversations(options: { limit?: number; unreadOnly?: boolean }): Promise<ChatSummary[]> {
    return daemonCall(route(this.profile, 'conversations'), { method: 'POST', body: options });
  }

  send(to: string, text: string): Promise<SendResult> {
    return daemonCall(route(this.profile, 'send'), { method: 'POST', body: { to, text } });
  }

  read(chat: string, options: { last?: number; receipts: boolean }): Promise<ReadResult> {
    return daemonCall(route(this.profile, 'read'), { method: 'POST', body: { chat, ...options } });
  }

  /** The file of a media message; the daemon fetches and decrypts it, and suggests its name. */
  download(chat: string, id: string): Promise<HubFile> {
    return daemonDownload(route(this.profile, 'media'), { method: 'POST', body: { chat, id }, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  }

  contacts(query?: string): Promise<ContactView[]> {
    return daemonCall(route(this.profile, 'contacts'), { method: 'POST', body: query ? { query } : {} });
  }
}

export function startPairing(profile: string, options: { phone?: string; readOnly?: boolean }): Promise<unknown> {
  return daemonCall(route(profile, 'pair'), { method: 'POST', body: options });
}

export function pollPairing(profile: string): Promise<PairState> {
  return daemonCall(route(profile, 'pair'));
}

export function cancelPairing(profile: string): Promise<unknown> {
  return daemonCall(route(profile, 'pair'), { method: 'DELETE' });
}
