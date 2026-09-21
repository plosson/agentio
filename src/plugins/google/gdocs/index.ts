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
  description: 'Use when interacting with Google Docs via the agentio CLI - list, read, create.',
  registerCommands: registerGDocsCommands,
  profile: {
    setup: gdocsProfileAdd,
    createClient: (credentials) => new GDocsClient(credentials),
    reauthenticate: reauthenticateGoogleCamel<GDocsCredentials>('gdocs'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
