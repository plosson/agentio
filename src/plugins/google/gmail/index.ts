import { gmailProfileAdd, registerGmailCommands } from './commands';
import { GmailClient } from './client';
import type { OAuthTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleAuthFromSnakeCredentials, googleSnakeCredentialLifecycle, reauthenticateGoogle, type GoogleSnakeCredentials } from '../shared';

export default defineServicePlugin<GoogleSnakeCredentials, OAuthTokens>()({
  apiVersion: 1,
  id: 'gmail',
  displayName: 'Gmail',
  description: 'Use when interacting with Gmail via the agentio CLI - list, read, search, send, draft, reply, archive, mark, attachments, export.',
  brand: { url: 'https://mail.google.com' },
  registerCommands: registerGmailCommands,
  profile: {
    setup: gmailProfileAdd,
    createClient: (credentials) => new GmailClient(googleAuthFromSnakeCredentials(credentials)),
    describe: (credentials) => ({ account: credentials.email }),
    reauthenticate: reauthenticateGoogle<GoogleSnakeCredentials>('gmail'),
  },
  credentialLifecycle: googleSnakeCredentialLifecycle,
});
