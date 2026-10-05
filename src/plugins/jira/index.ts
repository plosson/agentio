import { defineServicePlugin } from '../types';
import { JiraClient } from './client';
import { JIRA_SETUP_NEEDS, jiraProfileAdd, registerJiraCommands } from './commands';
import { jiraCredentialLifecycle, reauthenticateJira } from './lifecycle';
import type { JiraCredentials } from './types';

const jira = defineServicePlugin<JiraCredentials>()({
  apiVersion: 1,
  id: 'jira',
  displayName: 'JIRA',
  description: 'Use when interacting with JIRA via the agentio CLI - search issues, comment, transition.',
  registerCommands: registerJiraCommands,
  profile: {
    setup: jiraProfileAdd,
    needs: JIRA_SETUP_NEEDS,
    createClient: (credentials) => new JiraClient(credentials),
    describe: (credentials) => ({ url: credentials.siteUrl }),
    reauthenticate: reauthenticateJira,
  },
  credentialLifecycle: jiraCredentialLifecycle,
});

export default jira;
export { JiraClient } from './client';
export { jiraProfileAdd, registerJiraCommands } from './commands';
export { jiraCredentialLifecycle, reauthenticateJira } from './lifecycle';
export * from './oauth';
export * from './output';
export type * from './types';
