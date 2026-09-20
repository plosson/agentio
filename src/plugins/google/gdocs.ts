import { gdocsProfileAdd, registerGDocsCommands } from '../../commands/gdocs';
import { GDocsClient } from '../../services/gdocs/client';
import type { GDocsCredentials } from '../../types/gdocs';
import { defineServicePlugin } from '../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogleCamel } from './shared';

export default defineServicePlugin({
  apiVersion: 1,
  id: 'gdocs',
  displayName: 'Google Docs',
  description: 'Use when interacting with Google Docs via the agentio CLI - list, read, create.',
  registerCommands: registerGDocsCommands,
  profile: {
    add: gdocsProfileAdd,
    createClient: (credentials) => new GDocsClient(credentials as GDocsCredentials),
    reauthenticate: reauthenticateGoogleCamel('gdocs'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
