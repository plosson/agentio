import type { Command } from 'commander';
import { addExamples } from './command-tree';
import { CliError, handleError } from './errors';
import { addJsonOption, writeJson } from './output';
import { readStdinRaw } from './stdin';

/** The `ask` command shared by the services that answer a prompt in free text. */

export interface AskOptions {
  model?: string;
  system?: string;
  effort?: string;
  profile?: string;
  json?: boolean;
}

export interface AskRequest {
  prompt: string;
  model?: string;
  system?: string;
  effort?: string;
}

export interface AskResult {
  answer: string;
  model: string | null;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  durationMs: number;
}

/** The prompt argument, then piped stdin after a blank line; one of them is needed. */
export async function readPrompt(service: string, prompt: string | undefined, stdin: () => Promise<string | null> = readStdinRaw): Promise<string> {
  const parts = [prompt?.trim(), (await stdin())?.trim()].filter((part): part is string => !!part);
  if (parts.length === 0) {
    throw new CliError('INVALID_PARAMS', 'No prompt given', `Pass it as an argument, or pipe it: echo "…" | agentio ${service} ask`);
  }
  return parts.join('\n\n');
}

function optionalText(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new CliError('INVALID_PARAMS', `${flag} cannot be empty`);
  return value.trim();
}

export async function askRequest(service: string, prompt: string | undefined, options: AskOptions, stdin?: () => Promise<string | null>): Promise<AskRequest> {
  // Options first: a bad flag fails before stdin is read.
  const model = optionalText(options.model, '--model');
  const system = optionalText(options.system, '--system');
  const effort = optionalText(options.effort, '--effort');
  return { prompt: await readPrompt(service, prompt, stdin), model, system, effort };
}

export function printAnswer(result: AskResult, json?: boolean): void {
  if (json) {
    writeJson(result);
    return;
  }
  process.stdout.write(result.answer.endsWith('\n') ? result.answer : `${result.answer}\n`);
}

export function registerAskCommand(
  parent: Command,
  service: string,
  displayName: string,
  run: (request: AskRequest, profile?: string) => Promise<AskResult>,
): void {
  addExamples(
    addJsonOption(
      parent
        .command('ask')
        .description(`Ask ${displayName} and print the answer. A plain question: no tools, no files, no project settings`)
        .argument('[prompt]', 'The prompt; piped stdin is added after it')
        .option('--model <model>', 'Model (default: the profile\'s, else the CLI\'s default)')
        .option('--system <text>', 'System prompt')
        .option('--effort <level>', 'Reasoning effort, as the CLI names it (such as low, medium, high)')
        .option('--profile <name>', 'Profile name (optional if only one profile exists)'),
    ).action(async (prompt: string | undefined, options: AskOptions) => {
      try {
        printAnswer(await run(await askRequest(service, prompt, options), options.profile), options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio ${service} ask "What is the capital of France?"

  # a second opinion on a diff
  git diff | agentio ${service} ask "Review this change for bugs" --json`,
  );
}
