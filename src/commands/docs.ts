import { Command } from 'commander';
import { collectCommands, type CommandInfo } from '../utils/command-tree';

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
    .command('docs', { hidden: true })
    .description('Output CLI reference for LLMs')
    .option('--service <names>', 'Filter by service (comma-separated)', (val) => val.split(',').map((s: string) => s.trim()))
    .action((options) => {
      console.log(generateDocs(program, options.service));
    });
}
