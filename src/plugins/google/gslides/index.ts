import { gslidesProfileAdd, registerGSlidesCommands } from './commands';
import { GSlidesClient } from './client';
import type { GSlidesCredentials } from './types';
import type { GoogleCamelTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogleCamel } from '../shared';

export default defineServicePlugin<GSlidesCredentials, GoogleCamelTokens>()({
  apiVersion: 1,
  id: 'gslides',
  displayName: 'Google Slides',
  description: 'Use when interacting with Google Slides via the agentio CLI.',
  registerCommands: registerGSlidesCommands,
  profile: {
    add: gslidesProfileAdd,
    createClient: (credentials) => new GSlidesClient(credentials),
    reauthenticate: reauthenticateGoogleCamel<GSlidesCredentials>('gslides'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
