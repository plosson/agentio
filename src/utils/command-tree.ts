import { Command } from 'commander';

export interface CommandInfo {
  fullPath: string;
  description: string;
  arguments: string[];
  options: Array<{ flags: string; description: string; defaultValue?: string }>;
  examples?: string;
}

const EXAMPLES = new WeakMap<Command, string>();

/**
 * Records `text` for `cmd` in the side-table AND patches `cmd.helpInformation`
 * so `--help` appends the block. Returns `cmd` for chaining.
 *
 * Caveat: if the same command also has a prior `cmd.addHelpText('after', ...)`
 * call, `--help` will render two trailing blocks. Delete any prior
 * `addHelpText('after', ...)` before adopting `addExamples` on a command.
 */
export function addExamples(cmd: Command, text: string): Command {
  const isFirstRegistration = !EXAMPLES.has(cmd);
  EXAMPLES.set(cmd, text);

  // Patch `helpInformation` once so the example text is appended to the
  // returned string. `outputHelp()` (used by `--help`) calls
  // `helpInformation()` internally, so this single mechanism covers both
  // interactive `--help` output and direct `helpInformation` inspection
  // (used by the gate test and `agentio skill`). Calling
  // `cmd.addHelpText('after', ...)` in addition would cause `--help` to
  // render the EXAMPLES block twice.
  if (isFirstRegistration) {
    const original = cmd.helpInformation.bind(cmd);
    cmd.helpInformation = function patchedHelpInformation(
      ...args: Parameters<typeof original>
    ): string {
      const base = original(...args);
      const examples = EXAMPLES.get(cmd);
      if (!examples) return base;
      const trailingNewline = base.endsWith('\n') ? '' : '\n';
      return `${base}${trailingNewline}\n${examples}\n`;
    } as typeof cmd.helpInformation;
  }
  return cmd;
}

export function getExamples(cmd: Command): string | undefined {
  return EXAMPLES.get(cmd);
}

export function collectCommands(cmd: Command, parentPath: string = ''): CommandInfo[] {
  const results: CommandInfo[] = [];
  const help = cmd.createHelp();
  const subcommands = help.visibleCommands(cmd).filter((c) => c.name() !== 'help');

  for (const subcmd of subcommands) {
    const fullPath = parentPath ? `${parentPath} ${subcmd.name()}` : subcmd.name();

    const args = help.visibleArguments(subcmd).map((arg) => {
      const argName = arg.variadic ? `${arg.name()}...` : arg.name();
      return arg.required ? `<${argName}>` : `[${argName}]`;
    });

    const options = help
      .visibleOptions(subcmd)
      .filter((opt) => !opt.long?.includes('help'))
      .map((opt) => ({
        flags: opt.flags,
        description: opt.description,
        defaultValue: opt.defaultValue,
      }));

    const description = subcmd.description() || '';

    const childCommands = help.visibleCommands(subcmd).filter((c) => c.name() !== 'help');
    if (childCommands.length === 0 || options.length > 0 || args.length > 0) {
      results.push({
        fullPath,
        description,
        arguments: args,
        options,
        examples: getExamples(subcmd),
      });
    }

    results.push(...collectCommands(subcmd, fullPath));
  }

  return results;
}
