import { defineServicePlugin } from '../types';
import { ConfluenceClient } from './client';
import { confluenceProfileAdd, registerConfluenceCommands } from './commands';
import { CONFLUENCE_SETUP_NEEDS } from './setup-needs';
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
    needs: CONFLUENCE_SETUP_NEEDS,
    createClient: (credentials) => new ConfluenceClient(credentials),
    describe: (credentials) => ({ url: credentials.siteUrl }),
    reauthenticate: reauthenticateConfluence,
  },
  credentialLifecycle: confluenceCredentialLifecycle,
});
