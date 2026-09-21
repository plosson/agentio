import { gcalProfileAdd, registerGCalCommands } from './commands';
import { GCalClient } from './client';
import type { GCalCredentials } from './types';
import type { OAuthTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleAuthFromSnakeCredentials, googleSnakeCredentialLifecycle, reauthenticateGoogleSnake } from '../shared';

export default defineServicePlugin<GCalCredentials, OAuthTokens>()({
  apiVersion: 1,
  id: 'gcal',
  displayName: 'Google Calendar',
  description: 'Use when interacting with Google Calendar via the agentio CLI.',
  registerCommands: registerGCalCommands,
  profile: {
    setup: gcalProfileAdd,
    createClient: (credentials) => new GCalClient(googleAuthFromSnakeCredentials(credentials)),
    reauthenticate: reauthenticateGoogleSnake('gcal'),
  },
  credentialLifecycle: googleSnakeCredentialLifecycle,
});
