import { gmailProfileAdd, registerGmailCommands } from './commands';
import { GmailClient } from './client';
import type { OAuthTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleAuthFromSnakeCredentials, googleSnakeCredentialLifecycle, reauthenticateGoogleSnake, type GoogleSnakeCredentials } from '../shared';

export default defineServicePlugin<GoogleSnakeCredentials, OAuthTokens>()({
  apiVersion: 1,
  id: 'gmail',
  displayName: 'Gmail',
  description: 'Use when interacting with Gmail via the agentio CLI - list, read, search, send, draft, reply, archive, mark, attachments, export.',
  registerCommands: registerGmailCommands,
  profile: {
    add: gmailProfileAdd,
    createClient: (credentials) => new GmailClient(googleAuthFromSnakeCredentials(credentials)),
    reauthenticate: reauthenticateGoogleSnake('gmail'),
  },
  credentialLifecycle: googleSnakeCredentialLifecycle,
});
