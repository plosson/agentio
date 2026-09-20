import { gmailProfileAdd, registerGmailCommands } from '../../commands/gmail';
import { GmailClient } from '../../services/gmail/client';
import { defineServicePlugin } from '../types';
import { googleAuthFromSnakeCredentials, googleSnakeCredentialLifecycle, reauthenticateGoogleSnake } from './shared';

export default defineServicePlugin({
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
