import { gdriveProfileAdd, gdriveReauthenticate, registerGDriveCommands } from './commands';
import { GDriveClient } from './client';
import type { GDriveCredentials } from './types';
import type { GoogleCamelTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleCamelCredentialLifecycle } from '../shared';

export default defineServicePlugin<GDriveCredentials, GoogleCamelTokens>()({
  apiVersion: 1,
  id: 'gdrive',
  displayName: 'Google Drive',
  description: 'Use when interacting with Google Drive via the agentio CLI - list, search, download, upload, folder navigation.',
  brand: { url: 'https://drive.google.com' },
  registerCommands: registerGDriveCommands,
  profile: {
    setup: gdriveProfileAdd,
    createClient: (credentials) => new GDriveClient(credentials),
    describe: (credentials) => ({ account: credentials.email }),
    reauthenticate: gdriveReauthenticate(),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
