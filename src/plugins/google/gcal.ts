import { gcalProfileAdd, registerGCalCommands } from '../../commands/gcal';
import { GCalClient } from '../../services/gcal/client';
import { defineServicePlugin } from '../types';
import { googleAuthFromSnakeCredentials, googleSnakeCredentialLifecycle, reauthenticateGoogleSnake } from './shared';

export default defineServicePlugin({
  apiVersion: 1,
  id: 'gcal',
  displayName: 'Google Calendar',
  description: 'Use when interacting with Google Calendar via the agentio CLI.',
  registerCommands: registerGCalCommands,
  profile: {
    add: gcalProfileAdd,
    createClient: (credentials) => new GCalClient(googleAuthFromSnakeCredentials(credentials)),
    reauthenticate: reauthenticateGoogleSnake('gcal'),
  },
  credentialLifecycle: googleSnakeCredentialLifecycle,
});
