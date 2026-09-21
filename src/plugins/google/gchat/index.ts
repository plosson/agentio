import { gchatProfileAdd, registerGChatCommands } from './commands';
import { performOAuthFlow } from '../oauth';
import { fetchGoogleUserEmail } from '../token-manager';
import { GChatClient } from './client';
import type { GChatCredentials } from './types';
import type { GoogleCamelTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleCamelCredentialLifecycle } from '../shared';

export default defineServicePlugin<GChatCredentials, GoogleCamelTokens>()({
  apiVersion: 1,
  id: 'gchat',
  displayName: 'Google Chat',
  description: 'Use when interacting with Google Chat via the agentio CLI - send messages, list spaces, read history.',
  registerCommands: registerGChatCommands,
  profile: {
    setup: gchatProfileAdd,
    createClient: (credentials) => new GChatClient(credentials),
    async reauthenticate(credentials, profileName) {
      const existing = credentials;
      if (existing?.type === 'webhook') {
        console.error(`\nSkipping gchat / ${profileName}: webhook profiles don't expire. Run 'agentio gchat profile add' to update.`);
        return existing;
      }

      console.error(`\nRe-authenticating gchat / ${profileName}...`);
      const tokens = await performOAuthFlow('gchat');
      const email = await fetchGoogleUserEmail(tokens.access_token);
      console.error(`  Done (${email})`);
      return {
        ...existing,
        type: 'oauth' as const,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
        tokenType: tokens.token_type,
        scope: tokens.scope,
        email,
      };
    },
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
