import { Command } from 'commander';
import { CLAUDE_CLI, whichOnPath } from '../../utils/external-cli';
import { createClientGetter } from '../../utils/client-factory';
import { handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { registerAskCommand } from '../../utils/llm-ask';
import { createProfileCommands } from '../../utils/profile-commands';
import { addProfileWithSetup } from '../profile-host';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import { answerOrAsk } from '../setup-inputs';
import type { ProfileAddOptions } from '../types';
import { ClaudeClient, tokenKind } from './client';
import type { ClaudeCredentials } from './types';

/** Asked only when `claude` is installed. */
export const CLAUDE_CREATE_TOKEN_INPUT: InputSpec = {
  label: 'How do you want to add Claude?', kind: 'choice', default: 'setupToken',
  choices: [
    { value: 'setupToken', label: 'Create a subscription token now (runs claude setup-token)' },
    { value: 'paste', label: 'Paste a token or API key I already have' },
  ],
};
const CLAUDE_TOKEN_INPUT: InputSpec = {
  label: 'Token or API key', kind: 'secret',
  help: 'Run `claude setup-token` for your subscription, or create an API key at console.anthropic.com',
};
const CLAUDE_MODEL_INPUT: InputSpec = { label: 'Default model', kind: 'text', required: false, help: 'Such as opus or sonnet; blank for Claude Code\'s default' };

const getClaudeClient = createClientGetter<ClaudeCredentials, ClaudeClient>({
  service: 'claude',
  createClient: (credentials) => new ClaudeClient(credentials),
});

export interface ClaudeProfileAddOptions extends ProfileAddOptions {
  token?: string;
  model?: string;
}

/** Offer to run `claude setup-token` so the token it shows can be pasted next. */
async function offerSetupToken(context: SetupContext): Promise<void> {
  const claude = whichOnPath('claude');
  if (!claude) {
    context.log('`claude` is not installed here; prompts need it. Install it with `curl -fsSL https://claude.ai/install.sh | bash`. A token can still be added now.');
    return;
  }
  if ((await context.ask(CLAUDE_CREATE_TOKEN_INPUT)) !== 'setupToken') return;
  context.log('Opening `claude setup-token`; copy the token it shows, then paste it below.');
  if ((await context.runInTerminal([claude, 'setup-token'])) !== 0) {
    context.log('`claude setup-token` did not finish. A token can still be pasted below.');
  }
}

export async function claudeProfileAdd(options: ClaudeProfileAddOptions, context: SetupContext): Promise<SetupResult<ClaudeCredentials>> {
  if (options.token === undefined) await offerSetupToken(context);
  const token = await answerOrAsk(context, CLAUDE_TOKEN_INPUT, options.token);
  const kind = tokenKind(token);
  const model = (await answerOrAsk(context, CLAUDE_MODEL_INPUT, options.model)) || undefined;
  return {
    credentials: { token, kind, ...(model ? { model } : {}) },
    suggestedProfileName: 'default',
    info: `Claude ${kind === 'oauth' ? 'subscription token' : 'API key'} saved; prompts run through the claude CLI`,
  };
}

export function registerClaudeCommands(program: Command): void {
  const claude = program.command('claude').description('Ask Claude through the claude CLI (Claude Code), with a token from the vault');

  registerAskCommand(claude, 'claude', 'Claude', CLAUDE_CLI, async (request, profile) => {
    const { client } = await getClaudeClient(profile);
    return client.ask(request);
  });

  const profile = createProfileCommands<ClaudeCredentials>(claude, { service: 'claude', displayName: 'Claude' });

  addExamples(
    profile
      .command('add')
      .description('Add a Claude subscription token (offers to run claude setup-token) or an API key')
      .option('--token <token>', 'Token from `claude setup-token`, or an API key (asked for when absent)')
      .option('--model <model>', 'Default model, such as opus')
      .option('--profile <name>', 'Profile name (default: default)')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
      .action(async (options: ClaudeProfileAddOptions) => {
        try {
          await addProfileWithSetup('claude', (o, context) => claudeProfileAdd(o as ClaudeProfileAddOptions, context), options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # offers to run claude setup-token, then asks for the token it shows
  agentio claude profile add

  # a token or API key you already have
  agentio claude profile add --token sk-ant-api03-... --model opus`,
  );
}
