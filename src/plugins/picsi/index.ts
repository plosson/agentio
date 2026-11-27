import { defineServicePlugin } from '../types';
import { PicsiClient } from './client';
import { picsiProfileAdd, registerPicsiCommands } from './commands';
import type { PicsiCredentials } from './types';

export default defineServicePlugin<PicsiCredentials>()({
  apiVersion: 1,
  id: 'picsi',
  displayName: 'Picsi.Ai',
  description: 'Use when manually swapping a source face into a local image with a Picsi.Ai subscription, or checking remaining credits',
  brand: { url: 'https://www.picsi.ai/studio' },
  registerCommands: registerPicsiCommands,
  profile: {
    setup: picsiProfileAdd,
    createClient: (credentials) => new PicsiClient(credentials),
    reauthenticate: async (_credentials, _profile, context) => (await picsiProfileAdd({}, context)).credentials,
    describe: (credentials) => ({ account: credentials.email || credentials.name }),
  },
});
