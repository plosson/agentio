import { gtasksProfileAdd, registerGTasksCommands } from '../../commands/gtasks';
import { GTasksClient } from '../../services/gtasks/client';
import { defineServicePlugin } from '../types';
import { googleAuthFromSnakeCredentials, googleSnakeCredentialLifecycle, reauthenticateGoogleSnake } from './shared';

export default defineServicePlugin({
  apiVersion: 1,
  id: 'gtasks',
  displayName: 'Google Tasks',
  description: 'Use when interacting with Google Tasks via the agentio CLI.',
  registerCommands: registerGTasksCommands,
  profile: {
    add: gtasksProfileAdd,
    createClient: (credentials) => new GTasksClient(googleAuthFromSnakeCredentials(credentials)),
    reauthenticate: reauthenticateGoogleSnake('gtasks'),
  },
  credentialLifecycle: googleSnakeCredentialLifecycle,
});
