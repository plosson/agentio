import { GOOGLE_SETUP_NEEDS } from '../setup-needs';
import { gdocsProfileAdd, registerGDocsCommands } from './commands';
import { GDocsClient } from './client';
import type { GDocsCredentials } from './types';
import type { GoogleCamelTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogleCamel } from '../shared';

export default defineServicePlugin<GDocsCredentials, GoogleCamelTokens>()({
  apiVersion: 1,
  id: 'gdocs',
  displayName: 'Google Docs',
  description: 'Use when interacting with Google Docs via the agentio CLI - list, read, create, update from Markdown.',
  brand: { url: 'https://docs.google.com' },
  registerCommands: registerGDocsCommands,
  profile: {
    setup: gdocsProfileAdd,
    needs: GOOGLE_SETUP_NEEDS,
    createClient: (credentials) => new GDocsClient(credentials),
    describe: (credentials) => ({ account: credentials.email }),
    reauthenticate: reauthenticateGoogleCamel<GDocsCredentials>('gdocs'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
