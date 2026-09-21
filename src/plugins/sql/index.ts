import { defineServicePlugin } from '../types';
import { SqlClient } from './client';
import { registerSqlCommands, sqlProfileAdd } from './commands';
import type { SqlCredentials } from './types';

export default defineServicePlugin<SqlCredentials>()({
  apiVersion: 1,
  id: 'sql',
  displayName: 'SQL',
  description: 'Use when running SQL queries via the agentio CLI.',
  registerCommands: registerSqlCommands,
  profile: {
    setup: sqlProfileAdd,
    createClient: (credentials) => new SqlClient(credentials),
  },
});
