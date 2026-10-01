import { defineServicePlugin } from '../types';
import { TodoClient } from './client';
import { todoProfileAdd, reauthenticateTodo, registerTodoCommands } from './commands';
import type { TodoCredentials } from './types';

export default defineServicePlugin<TodoCredentials>()({
  apiVersion: 1,
  id: 'todo',
  displayName: 'Todo',
  description: 'Use when managing a personal tags-only todo list via the agentio CLI (add, list, check, remove).',
  brand: { color: '#0EA5E9' },
  registerCommands: registerTodoCommands,
  profile: {
    setup: todoProfileAdd,
    createClient: (credentials) => new TodoClient(credentials),
    reauthenticate: (credentials, profileName) => reauthenticateTodo(credentials, profileName),
  },
});
