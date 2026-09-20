import { gsheetsProfileAdd, registerGSheetsCommands } from '../../commands/gsheets';
import { GSheetsClient } from '../../services/gsheets/client';
import type { GSheetsCredentials } from '../../types/gsheets';
import { defineServicePlugin } from '../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogleCamel } from './shared';

export default defineServicePlugin({
  apiVersion: 1,
  id: 'gsheets',
  displayName: 'Google Sheets',
  description: 'Use when interacting with Google Sheets via the agentio CLI.',
  registerCommands: registerGSheetsCommands,
  profile: {
    add: gsheetsProfileAdd,
    createClient: (credentials) => new GSheetsClient(credentials as GSheetsCredentials),
    reauthenticate: reauthenticateGoogleCamel('gsheets'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
