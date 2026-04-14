import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { listProfiles } from '../config/config-manager';
import { interactiveCheckbox } from '../utils/interactive';
import { CliError, handleError } from '../utils/errors';
import {
  parseServiceProfiles,
  startMcpServer,
  type ServiceProfilePair,
} from '../mcp/server';
import { registerTeleportCommand } from './teleport';

const MCP_JSON = '.mcp.json';

/**
 * Load existing .mcp.json or return empty structure.
 */
async function loadMcpJson(
  dir: string
): Promise<Record<string, unknown>> {
  const filePath = join(dir, MCP_JSON);
  if (!existsSync(filePath)) {
    return {};
  }
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

/**
 * Write .mcp.json, merging with existing content.
 */
async function writeMcpJson(
  dir: string,
  pairs: ServiceProfilePair[]
): Promise<string> {
  const filePath = join(dir, MCP_JSON);
  const existing = await loadMcpJson(dir);

  const mcpServers = (existing.mcpServers as Record<string, unknown>) || {};

  // Build the args list
  const serveArgs = pairs.map((p) =>
    p.profile ? `${p.service}:${p.profile}` : p.service
  );

  mcpServers['agentio'] = {
    command: 'agentio',
    args: ['mcp', 'serve', ...serveArgs],
  };

  existing.mcpServers = mcpServers;

  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n');
  return filePath;
}

/**
 * Interactive mode: let user pick from configured profiles.
 */
async function interactiveInstall(): Promise<ServiceProfilePair[]> {
  const allProfiles = await listProfiles();
  const choices: Array<{
    name: string;
    value: ServiceProfilePair;
    checked?: boolean;
  }> = [];

  for (const { service, profiles } of allProfiles) {
    if (profiles.length === 0) continue;
    for (const profile of profiles) {
      choices.push({
        name: `${service}:${profile.name}`,
        value: { service, profile: profile.name },
      });
    }
  }

  if (choices.length === 0) {
    throw new CliError(
      'CONFIG_ERROR',
      'No profiles configured',
      'Add profiles first with: agentio <service> profile add'
    );
  }

  const selected = await interactiveCheckbox<ServiceProfilePair>({
    message: 'Select services to expose via MCP',
    choices,
    required: true,
  });

  return selected;
}

export function registerMcpCommands(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('MCP server operations');

  // serve subcommand
  mcp
    .command('serve')
    .description('Start stdio MCP server exposing CLI commands as tools')
    .argument('<pairs...>', 'Service:profile pairs (e.g., gmail:work slack:team rss)')
    .action(async (pairArgs: string[]) => {
      try {
        const pairs = parseServiceProfiles(pairArgs);
        await startMcpServer(pairs);
      } catch (error) {
        handleError(error);
      }
    });

  // install subcommand
  mcp
    .command('install')
    .description('Install MCP server config into .mcp.json')
    .argument('[pairs...]', 'Service:profile pairs (interactive if omitted)')
    .action(async (pairArgs: string[]) => {
      try {
        let pairs: ServiceProfilePair[];

        if (pairArgs && pairArgs.length > 0) {
          pairs = parseServiceProfiles(pairArgs);
        } else {
          pairs = await interactiveInstall();
        }

        if (pairs.length === 0) {
          console.log('No services selected.');
          return;
        }

        const filePath = await writeMcpJson(process.cwd(), pairs);

        const serveArgs = pairs
          .map((p) => (p.profile ? `${p.service}:${p.profile}` : p.service))
          .join(' ');

        console.log(`Wrote ${filePath}`);
        console.log(`\nMCP server command: agentio mcp serve ${serveArgs}`);
      } catch (error) {
        handleError(error);
      }
    });

  // teleport subcommand — `agentio mcp teleport <name>`. Lives here
  // (not at the top level) so all MCP-related commands are grouped.
  registerTeleportCommand(mcp);
}
