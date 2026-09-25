import { Command } from 'commander';
import { collectCommands, type CommandInfo } from '../utils/command-tree';
import { CliError, handleError } from '../utils/errors';

type DocsOption = CommandInfo['options'][number];

/** Whether the reference shows a default: Commander's value unless absent or ''. */
function shownDefault(opt: DocsOption): boolean {
  return opt.defaultValue !== undefined && opt.defaultValue !== '';
}

function formatOption(opt: DocsOption): string {
  let line = opt.flags;
  if (opt.description) {
    line += `: ${opt.description}`;
  }
  if (shownDefault(opt)) {
    line += ` (default: ${opt.defaultValue})`;
  }
  return line;
}

// Commands excluded from docs output by default (utility/meta commands)
const EXCLUDED_COMMANDS = ['config', 'status', 'update', 'claude', 'docs'];

function docsCommands(program: Command, services?: string[]): CommandInfo[] {
  let commands = collectCommands(program, 'agentio');

  // Filter by services if specified, otherwise exclude utility commands
  // Always exclude profile subcommands
  commands = commands.filter((cmd) => {
    if (cmd.fullPath.includes(' profile ')) {
      return false;
    }
    const parts = cmd.fullPath.split(' ');
    const service = parts[1];
    if (services && services.length > 0) {
      return services.includes(service);
    }
    return !EXCLUDED_COMMANDS.includes(service);
  });
  return commands;
}

function markdownDocs(version: string | undefined, commands: CommandInfo[]): string {
  const lines: string[] = [];
  lines.push(`# agentio CLI v${version}`);
  lines.push('');

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

/** The same reference as structured data; a default is the text the Markdown shows. */
function jsonDocs(version: string | undefined, commands: CommandInfo[]): string {
  return JSON.stringify(
    {
      version,
      commands: commands.map((cmd) => ({
        command: cmd.fullPath,
        description: cmd.description,
        arguments: cmd.arguments,
        options: cmd.options.map((opt) => ({
          flags: opt.flags,
          description: opt.description,
          ...(shownDefault(opt) ? { defaultValue: `${opt.defaultValue}` } : {}),
        })),
      })),
    },
    null,
    2,
  );
}

export function renderDocs(program: Command, options: { service?: string[]; format?: string }): string {
  const format = options.format ?? 'markdown';
  if (format !== 'markdown' && format !== 'json') {
    throw new CliError('INVALID_PARAMS', `Unknown format: ${format}`, 'Use --format markdown or --format json');
  }
  const commands = docsCommands(program, options.service);
  return format === 'json' ? jsonDocs(program.version(), commands) : markdownDocs(program.version(), commands);
}

export function registerDocsCommand(program: Command): void {
  program
    .command('docs', { hidden: true })
    .description('Output CLI reference for LLMs')
    .option('--service <names>', 'Filter by service (comma-separated)', (val) => val.split(',').map((s: string) => s.trim()))
    .option('--format <format>', 'Output format: markdown or json', 'markdown')
    .action((options) => {
      try {
        console.log(renderDocs(program, options));
      } catch (error) {
        handleError(error);
      }
    });
}
