import { Command } from 'commander';
import { activatePluginRegistry, DEFAULT_PLUGIN_REGISTRY, registerServiceCommands } from './plugins/registry';
import type { PluginRegistry } from './plugins/plugin-registry';

// Agentio utilities
import { registerDocsCommand } from './commands/docs';
import { registerDaemonCommands } from './commands/daemon';
import { registerDoctorCommand } from './commands/doctor';
import { registerGitHubVaultSecretCommands } from './commands/github-vault-secrets';
import { registerKeyCommands } from './commands/key';
import { registerLoginCommands } from './commands/login';
import { registerPluginCommands } from './commands/plugin';
import { registerProfileCommands } from './commands/profile';
import { registerReauthCommand } from './commands/reauth';
import { registerSkillCommand } from './commands/skill';
import { registerStatusCommand } from './commands/status';
import { registerUpdateCommand } from './commands/update';
import { registerVaultCommands } from './commands/vault';
import { vaultExists } from './vault/vault';
import { hubTooOldToManageError, isRemoteMode, remoteCanManageProfiles, remoteCannotManageError, remoteModeError } from './auth/remote';
import { CliError, handleError } from './utils/errors';
import { enterJsonMode } from './utils/output';

declare const BUILD_VERSION: string | undefined;

function getVersion(): string {
  if (typeof BUILD_VERSION !== 'undefined') {
    return BUILD_VERSION;
  }
  // Fallback for development mode
  return require('../package.json').version;
}

export function createProgram(registry: PluginRegistry = DEFAULT_PLUGIN_REGISTRY): Command {
  activatePluginRegistry(registry);
  const program = new Command();

  function setGroup(name: string, group: string): void {
    const cmd = program.commands.find((c) => c.name() === name);
    if (cmd) cmd.helpGroup(group);
  }

  program
    .name('agentio')
    .description('CLI for LLM agents to interact with communication and tracking services')
    .version(getVersion());

  registerServiceCommands(program, registry);
  registerGitHubVaultSecretCommands(program);

  // Agentio utilities
  registerDocsCommand(program);
  registerDaemonCommands(program);
  registerDoctorCommand(program);
  registerKeyCommands(program);
  registerLoginCommands(program);
  registerPluginCommands(program);
  registerProfileCommands(program, registry);
  registerReauthCommand(program);
  registerSkillCommand(program);
  registerStatusCommand(program);
  registerUpdateCommand(program);
  registerVaultCommands(program);

  // `setup` and `config` were folded into `vault` in 2.0. Keep hidden stubs so
  // the old names fail with a pointer to the new command rather than
  // commander's generic "unknown command" noise.
  for (const [removed, replacement] of [
    ['setup', 'agentio vault init'],
    ['config', 'agentio vault export | import | clear'],
  ]) {
    program
      .command(removed, { hidden: true })
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        console.error(`Error [INVALID_PARAMS]: \`agentio ${removed}\` was removed in 2.0`);
        console.error(`Suggestion: use \`${replacement}\` (see: agentio vault --help)`);
        process.exit(1);
      });
  }

  const BYPASS_COMMANDS = new Set(['docs', 'update', 'doctor', 'vault', 'login', 'logout', 'plugin']);
  // Profile subcommands an agent may run, given a key the owner marked canManageProfiles.
  const MANAGED_PROFILE_COMMANDS = new Set(['add', 'rename', 'remove']);
  // Owner-only on the hub host: they touch the vault or the daemon.
  const LOCAL_ONLY_COMMANDS = new Set(['vault', 'key', 'daemon', 'reauth']);

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    enterJsonMode(actionCommand);
    const name = actionCommand.name();
    const parent = actionCommand.parent?.name();

    if (isRemoteMode()) {
      // These reach the hub as a write; refuse before any OAuth or token dance when the key may not.
      if (parent === 'profile' && MANAGED_PROFILE_COMMANDS.has(name)) {
        try {
          const allowed = await remoteCanManageProfiles();
          if (allowed === undefined) throw hubTooOldToManageError();
          if (!allowed) throw remoteCannotManageError();
        } catch (err) {
          handleError(err);
        }
        return;
      }
      const localOnly =
        LOCAL_ONLY_COMMANDS.has(name) ||
        (parent && LOCAL_ONLY_COMMANDS.has(parent)) ||
        (parent === 'profile' && name !== 'list');
      if (localOnly) {
        const full = parent && parent !== 'agentio' ? `${parent} ${name}` : name;
        // Naming the hub decodes the token, which throws when it is malformed.
        try {
          throw remoteModeError(`\`agentio ${full}\``);
        } catch (err) {
          handleError(err);
        }
      }
      return;
    }

    // Top-level bypass commands OR any subcommand of a bypass command.
    if (BYPASS_COMMANDS.has(name) || (parent && BYPASS_COMMANDS.has(parent))) {
      return;
    }

    let exists: boolean;
    try {
      exists = await vaultExists();
    } catch (err) {
      handleError(err);
    }
    if (!exists) {
      handleError(new CliError('VAULT_NOT_CONFIGURED', 'No vault configured', 'Run: agentio vault init'));
    }
  });

  // Setup
  ['vault', 'login', 'logout', 'status', 'doctor', 'update'].forEach((n) => setGroup(n, 'Setup'));

  // Services
  registry.plugins.forEach(({ id }) => setGroup(id, 'Services'));

  // Advanced
  ['daemon', 'key', 'plugin', 'profile'].forEach((n) => setGroup(n, 'Advanced'));

  // Show help (exit 0) when no command is provided
  program.action(() => {
    program.help();
  });

  program.addHelpText(
    'after',
    '\nFor agent/LLM usage: run `agentio skill <service>` to dump a full SKILL.md, or `agentio docs` for the machine-readable command index.\n',
  );

  return program;
}
