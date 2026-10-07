import { Command } from 'commander';
import { createClientGetter } from '../../utils/client-factory';
import { handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { registerAskCommand } from '../../utils/llm-ask';
import { createProfileCommands } from '../../utils/profile-commands';
import { addProfileWithSetup, addSetupOptions } from '../profile-host';
import type { SetupContext, SetupResult } from '../../plugin-sdk';
import { checkAnswer } from '../setup-inputs';
import type { ProfileAddOptions } from '../types';
import { ClaudeClient, tokenKind } from './client';
import { CLAUDE_MODEL_INPUT, CLAUDE_TOKEN_INPUT } from './setup-needs';
import type { ClaudeCredentials } from './types';

const getClaudeClient = createClientGetter<ClaudeCredentials, ClaudeClient>({
  service: 'claude',
  createClient: (credentials) => new ClaudeClient(credentials),
});

export interface ClaudeProfileAddOptions extends ProfileAddOptions {
  token?: string;
  model?: string;
}

export async function claudeProfileAdd(options: ClaudeProfileAddOptions, context: SetupContext): Promise<SetupResult<ClaudeCredentials>> {
  const token = options.token !== undefined ? checkAnswer(CLAUDE_TOKEN_INPUT, options.token) : await context.ask(CLAUDE_TOKEN_INPUT);
  const kind = tokenKind(token);
  const model = (options.model !== undefined ? checkAnswer(CLAUDE_MODEL_INPUT, options.model) : await context.ask(CLAUDE_MODEL_INPUT)) || undefined;
  return {
    credentials: { token, kind, ...(model ? { model } : {}) },
    suggestedProfileName: 'default',
    info: `Claude ${kind === 'oauth' ? 'subscription token' : 'API key'} saved; prompts run through the claude CLI`,
  };
}

export function registerClaudeCommands(program: Command): void {
  const claude = program.command('claude').description('Ask Claude through the claude CLI (Claude Code), with a token from the vault');

  registerAskCommand(claude, 'claude', 'Claude', async (request, profile) => {
    const { client } = await getClaudeClient(profile);
    return client.ask(request);
  });

  const profile = createProfileCommands<ClaudeCredentials>(claude, { service: 'claude', displayName: 'Claude' });

  addExamples(
    addSetupOptions(
      profile
        .command('add')
        .description('Add a Claude subscription token (claude setup-token) or an API key')
        .option('--token <token>', 'Token from `claude setup-token`, or an API key (asked for when absent)')
        .option('--model <model>', 'Default model, such as opus')
        .option('--profile <name>', 'Profile name (default: default)')
        .option('--read-only', 'Create as read-only profile (blocks write operations)'),
    ).action(async (options: ClaudeProfileAddOptions) => {
      try {
        await addProfileWithSetup('claude', (o, context) => claudeProfileAdd(o as ClaudeProfileAddOptions, context), options);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # create a token for your subscription first; agentio asks for it
  claude setup-token
  agentio claude profile add --model opus`,
  );
}
