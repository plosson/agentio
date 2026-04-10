import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Command } from 'commander';
import { collectMcpTools, type McpToolDefinition } from './tools.js';

// Import all service registrations
import { registerDiscourseCommands } from '../commands/discourse';
import { registerGCalCommands } from '../commands/gcal';
import { registerGChatCommands } from '../commands/gchat';
import { registerGDocsCommands } from '../commands/gdocs';
import { registerGDriveCommands } from '../commands/gdrive';
import { registerGitHubCommands } from '../commands/github';
import { registerGmailCommands } from '../commands/gmail';
import { registerGSheetsCommands } from '../commands/gsheets';
import { registerGTasksCommands } from '../commands/gtasks';
import { registerJiraCommands } from '../commands/jira';
import { registerRssCommands } from '../commands/rss';
import { registerSlackCommands } from '../commands/slack';
import { registerSqlCommands } from '../commands/sql';
import { registerTelegramCommands } from '../commands/telegram';
import { registerWhatsAppCommands } from '../commands/whatsapp';

const SERVICE_REGISTRATIONS: Record<string, (program: Command) => void> = {
  discourse: registerDiscourseCommands,
  gcal: registerGCalCommands,
  gchat: registerGChatCommands,
  gdocs: registerGDocsCommands,
  gdrive: registerGDriveCommands,
  github: registerGitHubCommands,
  gmail: registerGmailCommands,
  gsheets: registerGSheetsCommands,
  gtasks: registerGTasksCommands,
  jira: registerJiraCommands,
  rss: registerRssCommands,
  slack: registerSlackCommands,
  sql: registerSqlCommands,
  telegram: registerTelegramCommands,
  whatsapp: registerWhatsAppCommands,
};

export interface ServiceProfilePair {
  service: string;
  profile?: string;
}

/**
 * Parse "service:profile" pairs from argv.
 */
export function parseServiceProfiles(args: string[]): ServiceProfilePair[] {
  return args.map((arg) => {
    const colonIndex = arg.indexOf(':');
    if (colonIndex === -1) {
      return { service: arg };
    }
    return {
      service: arg.substring(0, colonIndex),
      profile: arg.substring(colonIndex + 1),
    };
  });
}

/**
 * Build a commander program with only the requested services registered.
 */
function buildProgram(services: string[]): Command {
  const program = new Command();
  program.name('agentio').exitOverride();

  for (const service of services) {
    const register = SERVICE_REGISTRATIONS[service];
    if (register) {
      register(program);
    }
  }

  return program;
}

/**
 * Execute a command by capturing stdout output.
 * Builds argv from the tool definition + input arguments, injects --profile.
 */
async function executeCommand(
  program: Command,
  tool: McpToolDefinition,
  input: Record<string, unknown>,
  profile?: string
): Promise<string> {
  const argv = ['node', 'agentio', ...tool.commandPath];

  // Add positional arguments in order
  for (const argDef of tool.args) {
    const value = input[argDef.name];
    if (value !== undefined && value !== null) {
      if (argDef.variadic && Array.isArray(value)) {
        for (const v of value) {
          argv.push(String(v));
        }
      } else {
        argv.push(String(value));
      }
    }
  }

  // Add options
  for (const optDef of tool.options) {
    const paramName = optDef.long.replace(/-([a-z])/g, (_, c: string) =>
      c.toUpperCase()
    );
    const value = input[paramName];
    if (value !== undefined && value !== null) {
      if (typeof value === 'boolean') {
        if (value) {
          argv.push(`--${optDef.long}`);
        }
      } else if (Array.isArray(value)) {
        for (const v of value) {
          argv.push(`--${optDef.long}`, String(v));
        }
      } else {
        argv.push(`--${optDef.long}`, String(value));
      }
    }
  }

  // Inject --profile if provided
  if (profile) {
    argv.push('--profile', profile);
  }

  // Capture stdout
  const chunks: string[] = [];
  const originalLog = console.log;
  const originalWrite = process.stdout.write;

  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  };

  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    if (typeof chunk === 'string') {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk).toString());
    }
    return true;
  }) as typeof process.stdout.write;

  try {
    await program.parseAsync(argv);
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }

  return chunks.join('\n');
}

/**
 * Start the MCP stdio server with the given service:profile pairs.
 */
export async function startMcpServer(
  pairs: ServiceProfilePair[]
): Promise<void> {
  const services = [...new Set(pairs.map((p) => p.service))];

  // Validate services
  for (const service of services) {
    if (!SERVICE_REGISTRATIONS[service]) {
      console.error(`Unknown service: ${service}`);
      process.exit(1);
    }
  }

  // Build a profile lookup: service → profile
  const profileMap = new Map<string, string | undefined>();
  for (const pair of pairs) {
    profileMap.set(pair.service, pair.profile);
  }

  // Build commander program and collect tools
  const program = buildProgram(services);
  const allTools: McpToolDefinition[] = [];
  for (const service of services) {
    allTools.push(...collectMcpTools(program, service));
  }

  if (allTools.length === 0) {
    console.error('No tools found for the specified services');
    process.exit(1);
  }

  // Track last-checked timestamps per service:space for automatic --since injection
  const lastChecked = new Map<string, Date>();

  // Create MCP server
  const server = new Server(
    { name: 'agentio', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Handle list tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Handle call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = allTools.find((t) => t.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // Determine the service from the tool name to look up the profile
    const service = tool.commandPath[0];
    const profile = profileMap.get(service);

    const input = (args as Record<string, unknown>) || {};

    // Build a fresh program for each call to avoid state leaks
    const execProgram = buildProgram(services);

    try {
      const output = await executeCommand(
        execProgram,
        tool,
        input,
        profile
      );

      // For list commands, append last-checked info and update timestamp
      let result = output || '(no output)';
      if (name === 'gchat_list' && input.space) {
        const key = `gchat:${input.space}`;
        const last = lastChecked.get(key);
        if (last) {
          result += `\n\nPreviously checked: ${last.toISOString()}`;
        }
        lastChecked.set(key, new Date());
      }

      return {
        content: [{ type: 'text' as const, text: result }],
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
