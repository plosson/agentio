import { gdriveProfileAdd, registerGDriveCommands } from '../../commands/gdrive';
import { performOAuthFlow, type OAuthService } from './oauth';
import { fetchGoogleUserEmail } from './token-manager';
import { GDriveClient } from '../../services/gdrive/client';
import type { GDriveCredentials } from '../../types/gdrive';
import { defineServicePlugin } from '../types';
import { googleCamelCredentialLifecycle } from './shared';

export default defineServicePlugin({
  apiVersion: 1,
  id: 'gdrive',
  displayName: 'Google Drive',
  description: 'Use when interacting with Google Drive via the agentio CLI - list, search, download, upload, folder navigation.',
  registerCommands: registerGDriveCommands,
  profile: {
    add: gdriveProfileAdd,
    createClient: (credentials) => new GDriveClient(credentials as GDriveCredentials),
    async reauthenticate(credentials, profileName) {
      const existing = credentials as GDriveCredentials;
      const accessLevel = existing?.accessLevel || 'readonly';
      const oauthService: OAuthService = accessLevel === 'full' ? 'gdrive-full' : 'gdrive-readonly';

      console.error(`\nRe-authenticating gdrive / ${profileName}...`);
      const tokens = await performOAuthFlow(oauthService);
      const email = await fetchGoogleUserEmail(tokens.access_token);
      console.error(`  Done (${email}, ${accessLevel})`);
      return {
        ...existing,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
        tokenType: tokens.token_type,
        scope: tokens.scope,
        email,
        accessLevel,
      };
    },
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
