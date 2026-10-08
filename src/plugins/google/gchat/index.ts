import { gchatProfileAdd, gchatReauthenticate, registerGChatCommands } from './commands';
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
  brand: { url: 'https://chat.google.com' },
  registerCommands: registerGChatCommands,
  profile: {
    setup: gchatProfileAdd,
    createClient: (credentials) => new GChatClient(credentials),
    describe: (credentials) => ({ account: 'email' in credentials ? credentials.email : undefined }),
    reauthenticate: gchatReauthenticate(),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
