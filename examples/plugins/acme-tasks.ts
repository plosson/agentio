import type { AgentioPlugin } from '@plosson/agentio/plugin-sdk';

interface AcmeCredentials {
  token: string;
}

const plugin: AgentioPlugin<AcmeCredentials> = {
  apiVersion: 1,
  id: 'acme-tasks',
  displayName: 'Acme Tasks',
  description: 'Example external Agentio plugin',
  profile: {
    async setup(_options, context) {
      const token = await context.prompt('API token', { secret: true });
      return { credentials: { token }, suggestedProfileName: 'default' };
    },
    async validate() {
      return { valid: true, info: 'Example profile' };
    },
  },
  commands: [{
    path: 'tasks list',
    description: 'List example tasks',
    access: 'read',
    examples: ['agentio acme-tasks tasks list'],
    async run(_input, context) {
      context.log(`Using profile ${context.profile}`);
      return [{ id: 'TASK-1', title: 'Try the Agentio plugin SDK' }];
    },
  }],
};

export default plugin;
