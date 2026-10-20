import { defineServicePlugin } from '../types';
import { MemoryClient } from './client';
import { memoryProfileAdd, registerMemoryCommands } from './commands';
import type { MemoryCredentials } from './types';

export default defineServicePlugin<MemoryCredentials>()({
  apiVersion: 1,
  id: 'memory',
  displayName: 'Graphiti memory',
  description: 'Use when storing facts linked to a document id, or searching them, in a Graphiti knowledge graph via the agentio CLI.',
  registerCommands: registerMemoryCommands,
  profile: {
    setup: memoryProfileAdd,
    createClient: (credentials) => new MemoryClient(credentials),
    describe: (credentials) => ({ url: credentials.baseUrl }),
  },
});
