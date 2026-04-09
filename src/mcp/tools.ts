import { Command } from 'commander';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  /** The full commander path segments, e.g. ['gmail', 'search'] */
  commandPath: string[];
  /** Arguments in order, with metadata */
  args: Array<{ name: string; required: boolean; variadic: boolean }>;
  /** Options (long flag name → flag string for commander) */
  options: Array<{ long: string; flags: string; required: boolean }>;
}

/**
 * Walk the commander tree for a given service and produce MCP tool definitions.
 * Excludes profile subcommands and strips --profile from options.
 */
export function collectMcpTools(
  program: Command,
  service: string
): McpToolDefinition[] {
  const help = program.createHelp();
  const serviceCmd = help
    .visibleCommands(program)
    .find((c) => c.name() === service);

  if (!serviceCmd) {
    return [];
  }

  const results: McpToolDefinition[] = [];
  walkCommand(serviceCmd, [service], results);
  return results;
}

function walkCommand(
  cmd: Command,
  path: string[],
  results: McpToolDefinition[]
): void {
  const help = cmd.createHelp();
  const subcommands = help
    .visibleCommands(cmd)
    .filter((c) => c.name() !== 'help');

  // Skip profile subcommand tree entirely
  const nonProfileSubs = subcommands.filter((c) => c.name() !== 'profile');

  if (nonProfileSubs.length === 0) {
    // Leaf command — create a tool definition
    const tool = buildToolDefinition(cmd, path);
    if (tool) {
      results.push(tool);
    }
    return;
  }

  // If this command itself has arguments or meaningful options, also expose it
  const args = help.visibleArguments(cmd);
  const opts = help
    .visibleOptions(cmd)
    .filter(
      (o) => !o.long?.includes('help') && o.long !== '--profile'
    );
  if (args.length > 0 || opts.length > 0) {
    const tool = buildToolDefinition(cmd, path);
    if (tool) {
      results.push(tool);
    }
  }

  // Recurse into non-profile subcommands
  for (const sub of nonProfileSubs) {
    walkCommand(sub, [...path, sub.name()], results);
  }
}

function buildToolDefinition(
  cmd: Command,
  path: string[]
): McpToolDefinition | null {
  const help = cmd.createHelp();
  const toolName = path.join('_');
  const description = cmd.description() || toolName;

  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];

  // Arguments
  const argDefs: McpToolDefinition['args'] = [];
  for (const arg of help.visibleArguments(cmd)) {
    const paramName = arg.name().replace(/[^a-zA-Z0-9_]/g, '_');
    properties[paramName] = {
      type: 'string',
      ...(arg.description ? { description: arg.description } : {}),
    };
    if (arg.required) {
      required.push(paramName);
    }
    argDefs.push({
      name: paramName,
      required: arg.required,
      variadic: arg.variadic,
    });
  }

  // Options (skip --help, --profile)
  const optDefs: McpToolDefinition['options'] = [];
  for (const opt of help.visibleOptions(cmd)) {
    if (opt.long?.includes('help')) continue;
    if (opt.long === '--profile') continue;

    const longName = opt.long?.replace(/^--/, '') || '';
    if (!longName) continue;

    // Convert kebab-case to camelCase for the property name
    const paramName = longName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    // Determine type: boolean flags vs value options
    const isBoolean = opt.flags && !opt.flags.includes('<') && !opt.flags.includes('[');

    properties[paramName] = {
      type: isBoolean ? 'boolean' : 'string',
      ...(opt.description ? { description: opt.description } : {}),
    };

    // Note: Commander's opt.required means "value required when flag is used",
    // not "flag must be provided". Options are always optional in the MCP schema.
    optDefs.push({
      long: longName,
      flags: opt.flags,
      required: false,
    });
  }

  return {
    name: toolName,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    commandPath: path,
    args: argDefs,
    options: optDefs,
  };
}
