import { defineServicePlugin } from '../types';
import { KiteClient } from './client';
import { kiteProfileAdd, reauthenticateKite, registerKiteCommands } from './commands';
import { KITE_SETUP_NEEDS } from './setup-needs';
import type { KiteCredentials } from './types';

export default defineServicePlugin<KiteCredentials>()({
  apiVersion: 1,
  id: 'kite',
  displayName: 'Kite',
  description: 'Use when publishing Markdown or HTML documents as private web pages on Kite, sharing them, or reading and answering their comments via the agentio CLI.',
  brand: { color: '#0EA5E9' },
  registerCommands: registerKiteCommands,
  profile: {
    needs: KITE_SETUP_NEEDS,
    setup: kiteProfileAdd,
    createClient: (credentials) => new KiteClient(credentials),
    describe: (credentials) => ({ account: credentials.email, url: credentials.baseUrl }),
    reauthenticate: (credentials, profileName) => reauthenticateKite(credentials, profileName),
  },
});
