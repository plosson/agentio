import { delimiter } from 'path';
import type { Command } from 'commander';
import { loadPluginPaths } from '../plugins/external-loader';
import { PluginRegistry } from '../plugins/plugin-registry';
import { CliError, handleError } from '../utils/errors';
import { addExamples } from '../utils/command-tree';

export function registerPluginCommands(program: Command): void {
  const plugin = program.command('plugin').description('Develop and inspect external plugins');

  addExamples(
    plugin
      .command('verify')
      .description('Load and validate external plugin files or directories')
      .argument('<paths...>', 'Plugin files or flat plugin directories')
      .action(async (paths: string[]) => {
        try {
          const loaded = await loadPluginPaths(paths.join(delimiter));
          if (loaded.length === 0) throw new CliError('INVALID_PARAMS', 'No plugin modules found');
          new PluginRegistry(loaded);
          for (const candidate of loaded) {
            console.log(`${candidate.id}\tAPI ${candidate.apiVersion}\t${candidate.commands.length} commands\tvalid`);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # verify one plugin module
  agentio plugin verify /absolute/path/acme.ts

  # verify all modules in a flat directory
  agentio plugin verify /absolute/path/private-plugins`,
  );
}
