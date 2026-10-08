import { Command } from 'commander';
import { CODEX_CLI } from '../../utils/external-cli';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { registerAskCommand } from '../../utils/llm-ask';
import { createProfileCommands } from '../../utils/profile-commands';
import { addProfileWithSetup } from '../profile-host';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import { answerOrAsk, checkAnswer } from '../setup-inputs';
import type { ProfileAddOptions } from '../types';
import { ChatGptClient } from './client';
import { signInWithChatGpt } from './oauth';
import type { ChatGptCredentials } from './types';

const CHATGPT_METHOD_INPUT: InputSpec = {
  label: 'Sign in with', kind: 'choice', default: 'chatgpt',
  choices: [{ value: 'chatgpt', label: 'ChatGPT account (subscription)' }, { value: 'apiKey', label: 'OpenAI API key' }],
};
/** Asked only for the API key method. */
const CHATGPT_API_KEY_INPUT: InputSpec = { label: 'OpenAI API key', kind: 'secret', help: 'platform.openai.com → API keys' };
const CHATGPT_MODEL_INPUT: InputSpec = { label: 'Default model', kind: 'text', required: false, help: 'Blank for Codex\'s default' };

const getChatGptClient = createClientGetter<ChatGptCredentials, ChatGptClient>({
  service: 'chatgpt',
  createClient: (credentials) => new ChatGptClient(credentials),
});

export interface ChatGptProfileAddOptions extends ProfileAddOptions {
  method?: string;
  apiKey?: string;
  model?: string;
}

export async function chatGptProfileAdd(options: ChatGptProfileAddOptions, context: SetupContext): Promise<SetupResult<ChatGptCredentials>> {
  const chosen = options.method !== undefined ? checkAnswer(CHATGPT_METHOD_INPUT, options.method) : undefined;
  if (options.apiKey !== undefined && chosen !== undefined && chosen !== 'apiKey') {
    throw new CliError('INVALID_PARAMS', `--api-key cannot be used with --method ${chosen}`);
  }
  const method = options.apiKey !== undefined ? 'apiKey' : chosen ?? await context.ask(CHATGPT_METHOD_INPUT);
  const model = (await answerOrAsk(context, CHATGPT_MODEL_INPUT, options.model)) || undefined;

  if (method === 'apiKey') {
    const apiKey = await answerOrAsk(context, CHATGPT_API_KEY_INPUT, options.apiKey);
    return { credentials: { kind: 'apiKey', apiKey, ...(model ? { model } : {}) }, suggestedProfileName: 'default', info: 'OpenAI API key saved; prompts run through codex' };
  }
  const signedIn = await signInWithChatGpt(context, model);
  return {
    credentials: signedIn,
    suggestedProfileName: 'default',
    info: `Signed in to ChatGPT${signedIn.email ? ` as ${signedIn.email}` : ''}; prompts run through codex`,
  };
}

export function registerChatGptCommands(program: Command): void {
  const chatgpt = program.command('chatgpt').description('Ask ChatGPT through the codex CLI, with a sign-in or key from the vault');

  registerAskCommand(chatgpt, 'chatgpt', 'ChatGPT', CODEX_CLI, async (request, profile) => {
    const { client } = await getChatGptClient(profile);
    return client.ask(request);
  });

  const profile = createProfileCommands<ChatGptCredentials>(chatgpt, { service: 'chatgpt', displayName: 'ChatGPT' });

  addExamples(
    profile
      .command('add')
      .description('Sign in with your ChatGPT account, or add an OpenAI API key')
      .option('--method <method>', 'chatgpt (sign in in the browser) or apiKey')
      .option('--api-key <key>', 'OpenAI API key; implies --method apiKey')
      .option('--model <model>', 'Default model')
      .option('--profile <name>', 'Profile name (default: default)')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
      .action(async (options: ChatGptProfileAddOptions) => {
        try {
          await addProfileWithSetup('chatgpt', (o, context) => chatGptProfileAdd(o as ChatGptProfileAddOptions, context), options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # opens the browser to sign in with your ChatGPT account
  agentio chatgpt profile add --method chatgpt`,
  );
}
