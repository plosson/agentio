import { defineServicePlugin } from '../types';
import { DropboxClient } from './client';
import { dropboxProfileAdd, registerDropboxCommands } from './commands';
import { dropboxCredentialLifecycle, reauthenticateDropbox } from './lifecycle';
import type { DropboxCredentials } from './types';

export default defineServicePlugin<DropboxCredentials>()({
  apiVersion: 1,
  id: 'dropbox',
  displayName: 'Dropbox',
  description: 'Use when interacting with Dropbox via the agentio CLI - list, search, download, upload, move, copy, delete, share links.',
  registerCommands: registerDropboxCommands,
  profile: {
    add: dropboxProfileAdd,
    createClient: (credentials) => new DropboxClient(credentials),
    reauthenticate: reauthenticateDropbox,
  },
  credentialLifecycle: dropboxCredentialLifecycle,
});
