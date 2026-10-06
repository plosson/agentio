import { defineServicePlugin } from '../types';
import { NotesClient } from './client';
import { notesProfileAdd, registerNotesCommands } from './commands';
import { NOTES_SETUP_NEEDS } from './setup-needs';
import type { NotesCredentials } from './types';

export default defineServicePlugin<NotesCredentials>()({
  apiVersion: 1,
  id: 'notes',
  displayName: 'Apple Notes',
  description: 'Use when reading, searching or writing Apple Notes via the agentio CLI.',
  brand: { color: '#FFCC00' },
  registerCommands: registerNotesCommands,
  profile: {
    needs: NOTES_SETUP_NEEDS,
    setup: notesProfileAdd,
    createClient: (credentials) => new NotesClient(credentials),
    describe: (credentials) => ({ url: credentials.baseUrl }),
  },
});
