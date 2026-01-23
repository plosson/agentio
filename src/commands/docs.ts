import { Command } from 'commander';

interface CommandInfo {
  fullPath: string;
  description: string;
  arguments: string[];
  options: Array<{ flags: string; description: string; defaultValue?: string }>;
}

function collectCommands(cmd: Command, parentPath: string = ''): CommandInfo[] {
  const results: CommandInfo[] = [];
  const help = cmd.createHelp();

  // Get visible subcommands (filters out help command)
  const subcommands = help.visibleCommands(cmd).filter((c) => c.name() !== 'help');

  for (const subcmd of subcommands) {
    const fullPath = parentPath ? `${parentPath} ${subcmd.name()}` : subcmd.name();

    // Get arguments
    const args = help.visibleArguments(subcmd).map((arg) => {
      const argName = arg.variadic ? `${arg.name()}...` : arg.name();
      return arg.required ? `<${argName}>` : `[${argName}]`;
    });

    // Get options (filter out help)
    const options = help
      .visibleOptions(subcmd)
      .filter((opt) => !opt.long?.includes('help'))
      .map((opt) => {
        const flags = opt.flags;
        const desc = opt.description;
        const defaultVal = opt.defaultValue;
        return { flags, description: desc, defaultValue: defaultVal };
      });

    const description = subcmd.description() || '';

    // Only add if it's a leaf command or has its own action
    const childCommands = help.visibleCommands(subcmd).filter((c) => c.name() !== 'help');
    if (childCommands.length === 0 || options.length > 0 || args.length > 0) {
      results.push({
        fullPath,
        description,
        arguments: args,
        options,
      });
    }

    // Recurse into subcommands
    results.push(...collectCommands(subcmd, fullPath));
  }

  return results;
}

function formatOption(opt: { flags: string; description: string; defaultValue?: string }): string {
  let line = opt.flags;
  if (opt.description) {
    line += `: ${opt.description}`;
  }
  if (opt.defaultValue !== undefined && opt.defaultValue !== '') {
    line += ` (default: ${opt.defaultValue})`;
  }
  return line;
}

// Commands excluded from docs output by default (utility/meta commands)
const EXCLUDED_COMMANDS = ['config', 'status', 'update', 'claude', 'docs'];

function generateDocs(program: Command, services?: string[]): string {
  const lines: string[] = [];
  const version = program.version();

  lines.push(`# agentio CLI v${version}`);
  lines.push('');

  let commands = collectCommands(program, 'agentio');

  // Filter by services if specified, otherwise exclude utility commands
  commands = commands.filter((cmd) => {
    const parts = cmd.fullPath.split(' ');
    const service = parts[1];
    if (services && services.length > 0) {
      return services.includes(service);
    }
    return !EXCLUDED_COMMANDS.includes(service);
  });

  for (const cmd of commands) {
    // Header with full path and arguments
    let header = `## ${cmd.fullPath}`;
    if (cmd.arguments.length > 0) {
      header += ` ${cmd.arguments.join(' ')}`;
    }
    lines.push(header);

    // Description
    if (cmd.description) {
      lines.push(cmd.description);
    }

    // Options
    for (const opt of cmd.options) {
      lines.push(formatOption(opt));
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function registerDocsCommand(program: Command): void {
  program
    .command('docs')
    .description('Output CLI reference for LLMs')
    .option('--service <names>', 'Filter by service (comma-separated)', (val) => val.split(',').map((s: string) => s.trim()))
    .action((options) => {
      console.log(generateDocs(program, options.service));
    });
}
