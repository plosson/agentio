import type { Command } from 'commander';
import { getFreshCredentials } from '../auth/refresh';
import { requireProfile } from '../utils/client-factory';
import { addExamples } from '../utils/command-tree';
import { CliError, handleError } from '../utils/errors';
import { enforceWriteAccess } from '../utils/read-only';
import { readStdin } from '../utils/stdin';
import { createProfileCommands } from '../utils/profile-commands';
import { addProfileFromPlugin } from './profile-host';
import { createRunContext } from './host-context';
import type {
  AgentioPlugin,
  ArgumentSpec,
  CommandInput,
  CommandSpec,
  RunContext,
} from '../plugin-sdk';

function argumentSyntax(argument: ArgumentSpec): string {
  const name = argument.variadic ? `${argument.name}...` : argument.name;
  return argument.required ? `<${name}>` : `[${name}]`;
}

function nestedCommand(root: Command, path: string): Command {
  const parts = path.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('Plugin command path cannot be empty');
  let parent = root;
  for (const part of parts) {
    let child = parent.commands.find((command) => command.name() === part);
    if (!child) child = parent.command(part);
    parent = child;
  }
  return parent;
}

async function commandInput(
  spec: CommandSpec<any>,
  values: unknown[],
  command: Command,
): Promise<CommandInput> {
  const args: CommandInput['args'] = {};
  for (let index = 0; index < (spec.arguments?.length ?? 0); index++) {
    args[spec.arguments![index].name] = values[index] as string | string[] | undefined;
  }

  let stdin: CommandInput['stdin'];
  if (spec.input && spec.input !== 'none') {
    const raw = await readStdin();
    if (raw !== null) {
      if (spec.input === 'text') stdin = raw;
      else {
        try {
          stdin = JSON.parse(raw) as Record<string, unknown>;
        } catch (error) {
          throw new CliError('INVALID_PARAMS', `Invalid JSON on stdin: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  return { args, options: command.opts(), stdin };
}

/** Execute a declarative command through host-owned profile and access policy. */
export async function executeDeclarativeCommand(
  plugin: AgentioPlugin<any>,
  spec: CommandSpec<any>,
  input: CommandInput,
  options: Record<string, unknown>,
): Promise<unknown> {
  let credentials: Record<string, unknown> = {};
  let profile = '';

  if (plugin.profile) {
    profile = await requireProfile(plugin.id, options.profile as string | undefined);
    if (spec.access === 'write') await enforceWriteAccess(plugin.id, profile, spec.path);
    credentials = (await getFreshCredentials(plugin.id, profile)).credentials;
  }

  const context: RunContext<any> = createRunContext(credentials, profile);

  return spec.run(input, context);
}

function printResult(spec: CommandSpec<any>, result: unknown, options: Record<string, unknown>): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (spec.format) {
    const rendered = spec.format(result);
    if (rendered) console.log(rendered);
  } else if (typeof result === 'string') {
    console.log(result);
  } else if (result !== undefined) {
    console.log(JSON.stringify(result, null, 2));
  }
}

/** Render one public declarative plugin onto Commander. */
export function registerDeclarativePlugin(program: Command, plugin: AgentioPlugin<any>): void {
  const root = program.command(plugin.id).description(plugin.description);

  for (const spec of plugin.commands) {
    const command = nestedCommand(root, spec.path).description(spec.description);
    for (const argument of spec.arguments ?? []) command.argument(argumentSyntax(argument), argument.description);
    for (const option of spec.options ?? []) command.option(option.flags, option.description, option.defaultValue);
    if (plugin.profile && !(spec.options ?? []).some((option) => option.flags.includes('--profile'))) {
      command.option('--profile <name>', 'Profile name (optional if only one profile exists)');
    }
    if (!(spec.options ?? []).some((option) => /(^|[, ]+)--json(?:[, ]|$)/.test(option.flags))) {
      command.option('--json', 'Output structured JSON');
    }

    command.action(async (...values: unknown[]) => {
      try {
        const actionCommand = values.at(-1) as Command;
        const positional = values.slice(0, spec.arguments?.length ?? 0);
        const input = await commandInput(spec, positional, actionCommand);
        const result = await executeDeclarativeCommand(plugin, spec, input, actionCommand.opts());
        printResult(spec, result, actionCommand.opts());
      } catch (error) {
        handleError(error);
      }
    });

    addExamples(command, `Examples:\n\n${spec.examples.map((example) => `  ${example}`).join('\n')}`);
  }

  if (plugin.profile) {
    const profile = createProfileCommands(root, { service: plugin.id, displayName: plugin.displayName });
    profile
      .command('add')
      .description(`Add a new ${plugin.displayName} profile`)
      .option('--profile <name>', 'Profile name')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
      .action(async (options) => {
        try {
          await addProfileFromPlugin(plugin, options);
        } catch (error) {
          handleError(error);
        }
      });
  }
}
