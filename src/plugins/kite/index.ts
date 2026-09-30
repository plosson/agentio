import { defineServicePlugin } from '../types';
import { KiteClient } from './client';
import { kiteProfileAdd, reauthenticateKite, registerKiteCommands } from './commands';
import type { KiteCredentials } from './types';

export default defineServicePlugin<KiteCredentials>()({
  apiVersion: 1,
  id: 'kite',
  displayName: 'Kite',
  description: 'Use when publishing Markdown or HTML documents as private web pages on Kite, sharing them, or reading and answering their comments via the agentio CLI.',
  brand: { color: '#0EA5E9' },
  registerCommands: registerKiteCommands,
  profile: {
    setup: kiteProfileAdd,
    createClient: (credentials) => new KiteClient(credentials),
    reauthenticate: (credentials, profileName) => reauthenticateKite(credentials, profileName),
  },
});
