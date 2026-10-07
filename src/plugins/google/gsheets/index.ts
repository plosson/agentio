import { GOOGLE_SETUP_NEEDS } from '../setup-needs';
import { gsheetsProfileAdd, registerGSheetsCommands } from './commands';
import { GSheetsClient } from './client';
import type { GSheetsCredentials } from './types';
import type { GoogleCamelTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogleCamel } from '../shared';

export default defineServicePlugin<GSheetsCredentials, GoogleCamelTokens>()({
  apiVersion: 1,
  id: 'gsheets',
  displayName: 'Google Sheets',
  description: 'Use when interacting with Google Sheets via the agentio CLI.',
  brand: { url: 'https://sheets.google.com' },
  registerCommands: registerGSheetsCommands,
  profile: {
    setup: gsheetsProfileAdd,
    needs: GOOGLE_SETUP_NEEDS,
    createClient: (credentials) => new GSheetsClient(credentials),
    describe: (credentials) => ({ account: credentials.email }),
    reauthenticate: reauthenticateGoogleCamel<GSheetsCredentials>('gsheets'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
