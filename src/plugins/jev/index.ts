import { defineServicePlugin } from '../types';
import { JevClient } from './client';
import { jevProfileAdd, registerJevCommands } from './commands';
import { JEV_SETUP_NEEDS } from './setup-needs';
import type { JevCredentials } from './types';

export default defineServicePlugin<JevCredentials>()({
  apiVersion: 1,
  id: 'jev',
  displayName: 'Jev',
  description: 'Use when a script or agent needs a typed decision about some text (yes/no with a probability, one option from a set, or a score on a scale) from TypeSafe AI\'s Jev model, with the agentio CLI.',
  brand: { url: 'https://console.typesafe.ai' },
  registerCommands: registerJevCommands,
  profile: {
    needs: JEV_SETUP_NEEDS,
    setup: jevProfileAdd,
    createClient: (credentials) => new JevClient(credentials),
    describe: (credentials) => (credentials.model ? { account: credentials.model } : {}),
  },
});
