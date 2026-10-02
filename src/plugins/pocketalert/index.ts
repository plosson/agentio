import { defineServicePlugin } from '../types';
import { PocketAlertClient } from './client';
import { pocketAlertProfileAdd, registerPocketAlertCommands } from './commands';
import type { PocketAlertCredentials } from './types';

export default defineServicePlugin<PocketAlertCredentials>()({
  apiVersion: 1,
  id: 'pocketalert',
  displayName: 'Pocket Alert',
  description: 'Use when sending push notifications to phones via Pocket Alert with the agentio CLI.',
  brand: { url: 'https://pocketalert.app' },
  registerCommands: registerPocketAlertCommands,
  profile: {
    setup: pocketAlertProfileAdd,
    createClient: (credentials) => new PocketAlertClient(credentials),
  },
});
