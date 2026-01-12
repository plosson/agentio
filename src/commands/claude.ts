import { Command } from 'commander';
import * as path from 'path';
import { spawn } from 'child_process';
import { CliError, handleError } from '../utils/errors';
import {
  loadAgentioJson,
  addMarketplace,
  addPlugin,
  removeMarketplace,
  removePlugin,
} from '../services/claude-plugin/agentio-json';

/**
 * Determine if the argument is a marketplace URL or a plugin name.
 * - URL (contains :// or github.com/) -> marketplace
 * - Contains @ (e.g., plugin@marketplace) -> plugin
 */
function isMarketplaceUrl(arg: string): boolean {
  return arg.includes('://') || arg.startsWith('github.com/');
}

/**
 * Execute a claude CLI command and return the result.
 */
async function execClaude(
  args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        stdout,
        stderr,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        stdout: '',
        stderr: err.message,
      });
    });
  });
}

/**
 * Install a marketplace by calling claude plugin marketplace add.
 * Silently skips if already installed.
 */
async function installMarketplace(url: string): Promise<boolean> {
  console.error(`Adding marketplace: ${url}`);
  const result = await execClaude(['plugin', 'marketplace', 'add', url]);

  if (result.success) {
    console.log(`  Added: ${url}`);
    return true;
  }

  // Check if already installed (skip silently)
  const errLower = result.stderr.toLowerCase();
  if (errLower.includes('already') || errLower.includes('exists')) {
    console.log(`  Skipped (already added): ${url}`);
    return true;
  }

  console.error(`  Failed: ${result.stderr.trim()}`);
  return false;
}

/**
 * Install a plugin by calling claude plugin install --scope project.
 */
async function installPluginCmd(name: string): Promise<boolean> {
  console.error(`Installing plugin: ${name}`);
  const result = await execClaude(['plugin', 'install', name, '--scope', 'project']);

  if (result.success) {
    console.log(`  Installed: ${name}`);
    return true;
  }

  console.error(`  Failed: ${result.stderr.trim()}`);
  return false;
}

/**
 * Get list of installed marketplaces with their names and sources.
 */
async function getMarketplaces(): Promise<Array<{ name: string; source: string }>> {
  const result = await execClaude(['plugin', 'marketplace', 'list']);
  if (!result.success) {
    return [];
  }

  const marketplaces: Array<{ name: string; source: string }> = [];
  const lines = result.stdout.split('\n');

  let currentName: string | null = null;
  for (const line of lines) {
    // Match marketplace name: "  ❯ marketplace-name"
    const nameMatch = line.match(/^\s*❯\s+(.+)$/);
    if (nameMatch) {
      currentName = nameMatch[1].trim();
      continue;
    }

    // Match source line: "    Source: GitHub (user/repo)" or "    Source: Git (url)"
    const sourceMatch = line.match(/^\s*Source:\s*(?:GitHub|Git)\s*\((.+)\)$/);
    if (sourceMatch && currentName) {
      marketplaces.push({ name: currentName, source: sourceMatch[1].trim() });
      currentName = null;
    }
  }

  return marketplaces;
}

/**
 * Find marketplace name by URL.
 */
async function findMarketplaceName(url: string): Promise<string | null> {
  const marketplaces = await getMarketplaces();

  // Normalize the URL for comparison
  const normalizedUrl = url
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .toLowerCase();

  for (const mp of marketplaces) {
    const normalizedSource = mp.source
      .replace(/^https?:\/\//, '')
      .replace(/^github\.com\//, '')
      .replace(/\.git$/, '')
      .toLowerCase();

    if (normalizedSource === normalizedUrl || normalizedSource.includes(normalizedUrl) || normalizedUrl.includes(normalizedSource)) {
      return mp.name;
    }
  }

  return null;
}

/**
 * Update a marketplace by name.
 */
async function updateMarketplace(name: string): Promise<boolean> {
  console.error(`Updating marketplace: ${name}`);
  const result = await execClaude(['plugin', 'marketplace', 'update', name]);

  if (result.success) {
    console.log(`  Updated: ${name}`);
    return true;
  }

  console.error(`  Failed: ${result.stderr.trim()}`);
  return false;
}

/**
 * Uninstall a plugin by calling claude plugin uninstall --scope project.
 */
async function uninstallPluginCmd(name: string): Promise<boolean> {
  console.error(`Uninstalling plugin: ${name}`);
  const result = await execClaude(['plugin', 'uninstall', name, '--scope', 'project']);

  if (result.success) {
    console.log(`  Uninstalled: ${name}`);
    return true;
  }

  // Check if not installed (skip silently)
  const errLower = result.stderr.toLowerCase();
  if (errLower.includes('not installed') || errLower.includes('not found')) {
    console.log(`  Skipped (not installed): ${name}`);
    return true;
  }

  console.error(`  Failed: ${result.stderr.trim()}`);
  return false;
}

export function registerClaudeCommands(program: Command): void {
  const claude = program
    .command('claude')
    .description('Claude Code plugin operations');

  // install command - auto-detects marketplace vs plugin
  claude
    .command('install')
    .description('Install a marketplace (URL) or plugin (name@marketplace), or all from agentio.json')
    .argument('[target]', 'Marketplace URL or plugin name (e.g., plugin@marketplace)')
    .option('-d, --dir <path>', 'Directory with agentio.json (default: current directory)')
    .action(async (target, options) => {
      try {
        const targetDir = options.dir ? path.resolve(options.dir) : process.cwd();

        // No argument - install all from agentio.json
        if (!target) {
          const config = loadAgentioJson(targetDir);

          if (config.marketplaces.length === 0 && config.plugins.length === 0) {
            console.log('No marketplaces or plugins defined in agentio.json');
            return;
          }

          console.error(`Installing from agentio.json...`);

          // Install marketplaces first
          if (config.marketplaces.length > 0) {
            console.error(`\nMarketplaces (${config.marketplaces.length}):`);
            for (const url of config.marketplaces) {
              await installMarketplace(url);
            }
          }

          // Then install plugins
          if (config.plugins.length > 0) {
            console.error(`\nPlugins (${config.plugins.length}):`);
            for (const name of config.plugins) {
              await installPluginCmd(name);
            }
          }

          console.log('\nDone.');
          return;
        }

        // Auto-detect type based on argument format
        if (isMarketplaceUrl(target)) {
          // It's a marketplace URL
          const success = await installMarketplace(target);
          if (success) {
            addMarketplace(targetDir, target);
          }
        } else if (target.includes('@')) {
          // It's a plugin (contains @)
          const success = await installPluginCmd(target);
          if (success) {
            addPlugin(targetDir, target);
          }
        } else {
          throw new CliError(
            'INVALID_PARAMS',
            `Cannot determine type for: ${target}`,
            'Use a URL for marketplaces or name@marketplace for plugins'
          );
        }
      } catch (error) {
        handleError(error);
      }
    });

  // list command
  claude
    .command('list')
    .description('List marketplaces and plugins from agentio.json')
    .option('-d, --dir <path>', 'Directory with agentio.json (default: current directory)')
    .action(async (options) => {
      try {
        const targetDir = options.dir ? path.resolve(options.dir) : process.cwd();
        const config = loadAgentioJson(targetDir);

        if (config.marketplaces.length === 0 && config.plugins.length === 0) {
          console.log('No marketplaces or plugins defined in agentio.json');
          return;
        }

        if (config.marketplaces.length > 0) {
          console.log(`Marketplaces (${config.marketplaces.length}):`);
          for (const url of config.marketplaces) {
            console.log(`  ${url}`);
          }
        }

        if (config.plugins.length > 0) {
          if (config.marketplaces.length > 0) {
            console.log('');
          }
          console.log(`Plugins (${config.plugins.length}):`);
          for (const name of config.plugins) {
            console.log(`  ${name}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  // update command - updates marketplaces
  claude
    .command('update')
    .description('Update marketplaces (all from agentio.json or a specific URL)')
    .argument('[url]', 'Marketplace URL to update (updates all from agentio.json if not specified)')
    .option('-d, --dir <path>', 'Directory with agentio.json (default: current directory)')
    .action(async (url, options) => {
      try {
        const targetDir = options.dir ? path.resolve(options.dir) : process.cwd();

        if (url) {
          // Update specific marketplace by URL
          const name = await findMarketplaceName(url);
          if (!name) {
            throw new CliError('NOT_FOUND', `Marketplace not found for URL: ${url}`, 'Make sure the marketplace is installed');
          }
          await updateMarketplace(name);
        } else {
          // Update all marketplaces from agentio.json
          const config = loadAgentioJson(targetDir);

          if (config.marketplaces.length === 0) {
            console.log('No marketplaces defined in agentio.json');
            return;
          }

          console.error(`Updating marketplaces from agentio.json...`);

          for (const marketplaceUrl of config.marketplaces) {
            const name = await findMarketplaceName(marketplaceUrl);
            if (name) {
              await updateMarketplace(name);
            } else {
              console.error(`  Skipped (not installed): ${marketplaceUrl}`);
            }
          }

          console.log('\nDone.');
        }
      } catch (error) {
        handleError(error);
      }
    });

  // remove command - auto-detects marketplace vs plugin
  claude
    .command('remove')
    .description('Remove a marketplace (URL) or plugin (name@marketplace)')
    .argument('<target>', 'Marketplace URL or plugin name to remove')
    .option('-d, --dir <path>', 'Directory with agentio.json (default: current directory)')
    .action(async (target, options) => {
      try {
        const targetDir = options.dir ? path.resolve(options.dir) : process.cwd();

        // Auto-detect type based on argument format
        if (isMarketplaceUrl(target)) {
          // It's a marketplace URL
          const removed = removeMarketplace(targetDir, target);
          if (removed) {
            console.log(`Removed marketplace: ${target}`);
          } else {
            throw new CliError('NOT_FOUND', `Marketplace not found: ${target}`);
          }
        } else if (target.includes('@')) {
          // It's a plugin (contains @)
          await uninstallPluginCmd(target);
          removePlugin(targetDir, target);
        } else {
          throw new CliError(
            'INVALID_PARAMS',
            `Cannot determine type for: ${target}`,
            'Use a URL for marketplaces or name@marketplace for plugins'
          );
        }
      } catch (error) {
        handleError(error);
      }
    });
}
