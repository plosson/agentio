import { gdriveProfileAdd, registerGDriveCommands } from './commands';
import { performOAuthFlow, type OAuthService } from '../oauth';
import { fetchGoogleUserEmail } from '../token-manager';
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
  registerCommands: registerGDriveCommands,
  profile: {
    setup: gdriveProfileAdd,
    createClient: (credentials) => new GDriveClient(credentials),
    async reauthenticate(credentials, profileName) {
      const existing = credentials;
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
