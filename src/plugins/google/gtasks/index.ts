import { gtasksProfileAdd, registerGTasksCommands } from './commands';
import { GTasksClient } from './client';
import type { GTasksCredentials } from './types';
import type { OAuthTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleAuthFromSnakeCredentials, googleSnakeCredentialLifecycle, reauthenticateGoogleSnake } from '../shared';

export default defineServicePlugin<GTasksCredentials, OAuthTokens>()({
  apiVersion: 1,
  id: 'gtasks',
  displayName: 'Google Tasks',
  description: 'Use when interacting with Google Tasks via the agentio CLI.',
  registerCommands: registerGTasksCommands,
  profile: {
    setup: gtasksProfileAdd,
    createClient: (credentials) => new GTasksClient(googleAuthFromSnakeCredentials(credentials)),
    reauthenticate: reauthenticateGoogleSnake('gtasks'),
  },
  credentialLifecycle: googleSnakeCredentialLifecycle,
});
