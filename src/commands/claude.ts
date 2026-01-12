import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { CliError, handleError } from '../utils/errors';
import {
  loadAgentioJson,
  agentioJsonExists,
  listPlugins,
  removePlugin,
  getPlugin,
} from '../services/claude-plugin/agentio-json';
import {
  installPlugin,
  removePluginFiles,
} from '../services/claude-plugin/installer';
import type { InstalledComponent } from '../types/claude-plugin';

export function registerClaudeCommands(program: Command): void {
  const claude = program
    .command('claude')
    .description('Claude Code plugin operations');

  const plugin = claude.command('plugin').description('Manage Claude Code plugins');

  plugin
    .command('install')
    .description('Install plugin(s) from GitHub or agentio.json')
    .argument('[source]', 'GitHub URL or owner/repo (omit to install from agentio.json)')
    .option('--skills', 'Install only skills')
    .option('--commands', 'Install only commands')
    .option('--hooks', 'Install only hooks')
    .option('--agents', 'Install only agents')
    .option('-f, --force', 'Force reinstall if already exists')
    .option('-d, --dir <path>', 'Target directory (default: current directory)')
    .option('-v, --verbose', 'Show detailed installation logs')
    .action(async (source, options) => {
      try {
        const targetDir = options.dir ? path.resolve(options.dir) : process.cwd();

        if (!fs.existsSync(targetDir)) {
          throw new CliError('INVALID_PARAMS', `Directory does not exist: ${targetDir}`);
        }

        if (source) {
          // Install specific plugin from source
          console.error(`Installing plugin from: ${source}`);
          console.error(`Target: ${path.join(targetDir, '.claude')}`);

          const result = await installPlugin(source, {
            skills: options.skills,
            commands: options.commands,
            hooks: options.hooks,
            agents: options.agents,
            force: options.force,
            targetDir,
            verbose: options.verbose,
          });

          console.log(`\nInstalled: ${result.manifest.name} v${result.manifest.version}`);
          if (result.installed.length > 0) {
            console.log(`Components: ${result.installed.length}`);
            for (const comp of result.installed) {
              console.log(`  ${comp.type}/${comp.name}`);
            }
          }
        } else {
          // Install all plugins from agentio.json
          if (!agentioJsonExists(targetDir)) {
            throw new CliError(
              'NOT_FOUND',
              'No agentio.json found',
              'Run: agentio claude plugin install <source> to install a plugin'
            );
          }

          const agentioJson = loadAgentioJson(targetDir);
          const plugins = Object.entries(agentioJson.plugins);

          if (plugins.length === 0) {
            console.log('No plugins defined in agentio.json');
            return;
          }

          console.error(`Installing ${plugins.length} plugin(s) from agentio.json...`);
          console.error(`Target: ${path.join(targetDir, '.claude')}`);

          let installed = 0;
          for (const [name, entry] of plugins) {
            console.error(`\nInstalling ${name}...`);

            // Determine component flags based on entry.components
            const installOptions = {
              skills:
                !entry.components || entry.components.includes('skills'),
              commands:
                !entry.components || entry.components.includes('commands'),
              hooks: !entry.components || entry.components.includes('hooks'),
              agents: !entry.components || entry.components.includes('agents'),
              force: options.force,
              targetDir,
              verbose: options.verbose,
            };

            try {
              const result = await installPlugin(entry.source, installOptions);
              console.log(`  Installed: ${result.manifest.name} v${result.manifest.version}`);
              installed++;
            } catch (error) {
              console.error(`  Failed to install ${name}: ${error}`);
            }
          }

          console.log(`\nInstalled ${installed} of ${plugins.length} plugin(s)`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  plugin
    .command('list')
    .description('List plugins from agentio.json')
    .option('-d, --dir <path>', 'Directory with agentio.json (default: current directory)')
    .action(async (options) => {
      try {
        const targetDir = options.dir ? path.resolve(options.dir) : process.cwd();

        const plugins = listPlugins(targetDir);

        if (plugins.length === 0) {
          console.log('No plugins in agentio.json');
          return;
        }

        console.log(`Plugins (${plugins.length}):\n`);
        for (const { name, entry } of plugins) {
          console.log(`${name} v${entry.version}`);
          console.log(`  Source: ${entry.source}`);
          if (entry.components) {
            console.log(`  Components: ${entry.components.join(', ')}`);
          }
          console.log('');
        }
      } catch (error) {
        handleError(error);
      }
    });

  plugin
    .command('remove')
    .description('Remove an installed plugin')
    .argument('<name>', 'Plugin name')
    .option('-d, --dir <path>', 'Directory with agentio.json (default: current directory)')
    .action(async (name, options) => {
      try {
        const targetDir = options.dir ? path.resolve(options.dir) : process.cwd();

        const entry = getPlugin(targetDir, name);
        if (!entry) {
          throw new CliError('NOT_FOUND', `Plugin '${name}' not found in agentio.json`);
        }

        console.error(`Removing plugin: ${name}...`);

        // Use stored installed components (no network calls needed)
        const components: InstalledComponent[] = entry.installedComponents || [];

        // Remove files
        removePluginFiles(targetDir, components);

        // Update agentio.json
        removePlugin(targetDir, name);

        console.log(`Removed: ${name}`);
        if (components.length > 0) {
          console.log(`Removed components: ${components.length}`);
          for (const comp of components) {
            console.log(`  ${comp.type}/${comp.name}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });
}
