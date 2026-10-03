import { gchatProfileAdd, registerGChatCommands } from './commands';
import { GChatClient } from './client';
import type { GChatCredentials } from './types';
import type { GoogleCamelTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogle } from '../shared';

const renewOAuth = reauthenticateGoogle<GChatCredentials>('gchat');

export default defineServicePlugin<GChatCredentials, GoogleCamelTokens>()({
  apiVersion: 1,
  id: 'gchat',
  displayName: 'Google Chat',
  description: 'Use when interacting with Google Chat via the agentio CLI - send messages, list spaces, read history.',
  brand: { url: 'https://chat.google.com' },
  registerCommands: registerGChatCommands,
  profile: {
    setup: gchatProfileAdd,
    createClient: (credentials) => new GChatClient(credentials),
    describe: (credentials) => ({ account: 'email' in credentials ? credentials.email : undefined }),
    async reauthenticate(credentials, profileName) {
      if (credentials?.type === 'webhook') {
        console.error(`\nSkipping gchat / ${profileName}: webhook profiles don't expire. Run 'agentio gchat profile add' to update.`);
        return credentials;
      }
      return renewOAuth(credentials, profileName);
    },
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
