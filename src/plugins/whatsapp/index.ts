import { defineServicePlugin } from '../types';
import { registerWhatsAppCommands } from './commands';
import { whatsappSessions } from './session';

/**
 * WhatsApp, through Baileys (the unofficial WhatsApp Web protocol). The
 * daemon owns the socket: every command, pairing included, is a request to
 * it, and the CLI never opens a connection of its own.
 */
const whatsapp = defineServicePlugin()({
  apiVersion: 1,
  id: 'whatsapp',
  displayName: 'WhatsApp',
  description: 'Use when sending or reading WhatsApp messages via the agentio CLI.',
  brand: { color: '#25D366' },
  registerCommands: registerWhatsAppCommands,
  session: whatsappSessions(),
});

export default whatsapp;
export { WhatsAppClient } from './client';
export { registerWhatsAppCommands, pairWhatsAppProfile } from './commands';
export * from './output';
export type * from './types';
