import { Command } from 'commander';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { optionalText } from '../../utils/options';
import { addJsonOption } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { readStdin } from '../../utils/stdin';
import { addProfileWithSetup, addSetupOptions } from '../profile-host';
import type { SetupContext, SetupResult } from '../../plugin-sdk';
import { checkAnswer } from '../setup-inputs';
import type { ProfileAddOptions } from '../types';
import { JevClient } from './client';
import { printChoice, printScore, printYesNo } from './output';
import { parseLevels, parseOptions, parseState, parseThreshold, requireQuestion } from './questions';
import { JEV_API_KEY_INPUT, JEV_MODEL_INPUT } from './setup-needs';
import type { JevChoiceAnswer, JevCredentials, JevNoulAnswer, JevScoreAnswer, JevState } from './types';

/** Exit code of `yesno` for an error that would otherwise exit 1, which means "no" there. */
export const YESNO_ERROR_EXIT = 6;

const getJevClient = createClientGetter<JevCredentials, JevClient>({
  service: 'jev',
  createClient: (credentials) => new JevClient(credentials),
});

const collect = (value: string, previous: string[]) => [...previous, value];

/** The state: piped stdin, or `--state`; both at once is refused. */
export async function readState(stateOption: string | undefined): Promise<JevState> {
  const piped = await readStdin();
  if (piped && stateOption !== undefined) {
    throw new CliError('INVALID_PARAMS', 'Input given both on stdin and with --state', 'Use one of them');
  }
  return parseState(piped || stateOption || '');
}

export interface JevProfileAddOptions extends ProfileAddOptions {
  apiKey?: string;
  model?: string;
}

export async function jevProfileAdd(options: JevProfileAddOptions, context: SetupContext): Promise<SetupResult<JevCredentials>> {
  const apiKey = options.apiKey !== undefined ? checkAnswer(JEV_API_KEY_INPUT, options.apiKey) : await context.ask(JEV_API_KEY_INPUT);
  const model = (options.model !== undefined ? checkAnswer(JEV_MODEL_INPUT, options.model) : await context.ask(JEV_MODEL_INPUT)) || undefined;
  const credentials: JevCredentials = { apiKey, ...(model ? { model } : {}) };
  // One short question proves the key and the model before the profile is saved.
  await new JevClient(credentials).ask('Hello there', { type: 'noul', instructions: 'Is this a greeting?' });
  return { credentials, suggestedProfileName: 'default', info: `Connected to Jev${model ? ` (${model})` : ''}` };
}

function withCommonOptions(cmd: Command): Command {
  return addJsonOption(
    cmd
      .option('--state <text>', 'What to evaluate, when nothing is piped on stdin')
      .option('--model <model>', 'Model (default: the profile\'s, else jev-latest)')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)'),
  );
}

export function registerJevCommands(program: Command): void {
  const jev = program.command('jev').description('Ask Jev typed questions about some input: yes/no, choice, score');

  addExamples(
    withCommonOptions(
      jev
        .command('yesno')
        .description('Ask a yes/no question. Exit code 0 is yes, 1 is no, 2 or more is an error')
        // Commander exits 1 on a usage error, which here means "no": exit 6 instead. --help stays 0.
        .exitOverride((error) => process.exit(error.exitCode === 0 ? 0 : YESNO_ERROR_EXIT))
        .argument('<question>', 'The yes/no question')
        .option('--threshold <p>', 'Probability of yes at or above which the answer is yes', '0.5'),
    ).action(async (question: string, options) => {
      try {
        const instructions = requireQuestion(question);
        const threshold = parseThreshold(options.threshold);
        const model = optionalText(options.model, '--model');
        const state = await readState(options.state);
        const { client } = await getJevClient(options.profile);
        const result = await client.ask<JevNoulAnswer>(state, { type: 'noul', instructions }, model);
        const yes = result.answer.noul >= threshold;
        printYesNo(result, yes, options.json);
        process.exit(yes ? 0 : 1);
      } catch (error) {
        handleError(error, YESNO_ERROR_EXIT);
      }
    }),
    `Examples:

  agentio gmail get <id> | agentio jev yesno "Does this email need a reply?"

  # in a script: exit code 0 is yes, 1 is no, 2 or more is an error
  if agentio jev yesno "Is this urgent?" --threshold 0.8 < ticket.txt; then echo urgent; fi`,
  );

  addExamples(
    withCommonOptions(
      jev
        .command('choice')
        .description('Pick one option from a set')
        .argument('<question>', 'The question')
        .option('--option <key=description>', 'An option, as key=description (repeat, at least 2)', collect, []),
    ).action(async (question: string, options) => {
      try {
        const instructions = requireQuestion(question);
        const criteria = parseOptions(options.option);
        const model = optionalText(options.model, '--model');
        const state = await readState(options.state);
        const { client } = await getJevClient(options.profile);
        printChoice(await client.ask<JevChoiceAnswer>(state, { type: 'choice', instructions, criteria }, model), options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio jev choice "Which team should handle this?" \\
    --option billing="Charges, invoices, payments" \\
    --option shipping="Delivery, delays, lost packages" < ticket.txt`,
  );

  addExamples(
    withCommonOptions(
      jev
        .command('score')
        .description('Place the input on a ranked scale')
        .argument('<question>', 'The question')
        .option('--level <description>', 'A level, lowest first (repeat, 2 to 10)', collect, []),
    ).action(async (question: string, options) => {
      try {
        const instructions = requireQuestion(question);
        const criteria = parseLevels(options.level);
        const model = optionalText(options.model, '--model');
        const state = await readState(options.state);
        const { client } = await getJevClient(options.profile);
        printScore(await client.ask<JevScoreAnswer>(state, { type: 'score', instructions, criteria }, model), options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio jev score "How severe is this bug?" \\
    --level "Cosmetic" --level "Broken, with a workaround" --level "Blocking" < bug.txt`,
  );

  const profile = createProfileCommands<JevCredentials>(jev, { service: 'jev', displayName: 'Jev' });

  addExamples(
    addSetupOptions(
      profile
        .command('add')
        .description('Add a Jev account with its API key')
        .option('--api-key <key>', 'API key, from console.typesafe.ai (asked for when absent)')
        .option('--model <model>', 'Default model (default: jev-latest)')
        .option('--profile <name>', 'Profile name (default: default)')
        .option('--read-only', 'Create as read-only profile (blocks write operations)'),
    ).action(async (options: JevProfileAddOptions) => {
      try {
        await addProfileWithSetup('jev', (o, context) => jevProfileAdd(o as JevProfileAddOptions, context), options);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # asks for the API key, so it stays out of shell history
  agentio jev profile add`,
  );
}
