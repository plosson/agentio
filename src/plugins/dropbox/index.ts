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
  brand: { url: 'https://www.dropbox.com' },
  registerCommands: registerDropboxCommands,
  profile: {
    setup: dropboxProfileAdd,
    createClient: (credentials) => new DropboxClient(credentials),
    describe: (credentials) => ({ account: credentials.email ?? credentials.name }),
    reauthenticate: reauthenticateDropbox,
  },
  credentialLifecycle: dropboxCredentialLifecycle,
});
