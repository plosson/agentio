import { defineServicePlugin } from '../types';
import { FalcoClient } from './client';
import { falcoProfileAdd, registerFalcoCommands } from './commands';
import { falcoCredentialLifecycle, reauthenticateFalco } from './lifecycle';
import type { FalcoCredentials } from './types';

export default defineServicePlugin<FalcoCredentials>()({
  apiVersion: 1,
  id: 'falco',
  displayName: 'Falco',
  description: 'Use when interacting with Falco accounting and Peppol documents via the agentio CLI.',
  registerCommands: registerFalcoCommands,
  profile: {
    setup: falcoProfileAdd,
    createClient: (credentials) => new FalcoClient(credentials),
    reauthenticate: reauthenticateFalco,
  },
  credentialLifecycle: falcoCredentialLifecycle,
});
