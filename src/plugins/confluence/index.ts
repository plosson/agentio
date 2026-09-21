import { defineServicePlugin } from '../types';
import { ConfluenceClient } from './client';
import { confluenceProfileAdd, registerConfluenceCommands } from './commands';
import { confluenceCredentialLifecycle, reauthenticateConfluence } from './lifecycle';
import type { ConfluenceCredentials } from './types';

export default defineServicePlugin<ConfluenceCredentials>()({
  apiVersion: 1,
  id: 'confluence',
  displayName: 'Confluence',
  description: 'Use when interacting with Confluence via the agentio CLI.',
  registerCommands: registerConfluenceCommands,
  profile: {
    setup: confluenceProfileAdd,
    createClient: (credentials) => new ConfluenceClient(credentials),
    reauthenticate: reauthenticateConfluence,
  },
  credentialLifecycle: confluenceCredentialLifecycle,
});
