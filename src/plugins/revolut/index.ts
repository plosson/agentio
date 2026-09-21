import { defineServicePlugin } from '../types';
import { RevolutClient } from './client';
import { registerRevolutCommands, revolutProfileAdd } from './commands';
import { reauthenticateRevolut, revolutCredentialLifecycle } from './lifecycle';
import type { RevolutCredentials } from './types';

export default defineServicePlugin<RevolutCredentials>()({
  apiVersion: 1,
  id: 'revolut',
  displayName: 'Revolut',
  description: 'Use when interacting with Revolut Business via the agentio CLI.',
  registerCommands: registerRevolutCommands,
  profile: {
    setup: revolutProfileAdd,
    createClient: (credentials) => new RevolutClient(credentials),
    reauthenticate: reauthenticateRevolut,
  },
  credentialLifecycle: revolutCredentialLifecycle,
});
