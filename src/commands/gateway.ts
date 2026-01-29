import { Command } from 'commander';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { handleError, CliError } from '../utils/errors';
import { loadConfig, saveConfig } from '../config/config-manager';
import { startDaemon, stopDaemon, getDaemonStatus, reloadDaemon, LOG_FILE } from '../gateway/daemon';
import { exportWhatsAppAuthState, importWhatsAppAuthState } from '../gateway/store';
import type { Config } from '../types/config';

export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command('gateway')
    .description('Gateway daemon management');

  gateway
    .command('start')
    .description('Start the gateway daemon')
    .option('--foreground', 'Run in foreground (don\'t daemonize)')
    .action(async (options) => {
      try {
        await startDaemon({ foreground: options.foreground });
      } catch (error) {
        handleError(error);
      }
    });

  gateway
    .command('stop')
    .description('Stop the gateway daemon')
    .action(async () => {
      try {
        await stopDaemon();
      } catch (error) {
        handleError(error);
      }
    });

  gateway
    .command('status')
    .description('Show gateway daemon status')
    .action(async () => {
      try {
        const status = await getDaemonStatus();

        if (!status.running) {
          console.log('Gateway: stopped');
          return;
        }

        console.log(`Gateway: running (PID ${status.pid})`);

        if (status.adapters && status.adapters.length > 0) {
          console.log('\nConnected adapters:');
          for (const adapter of status.adapters) {
            const statusIcon = adapter.connected ? '✓' : '✗';
            console.log(`  ${statusIcon} ${adapter.service}:${adapter.profile}`);
          }
        } else {
          console.log('\nNo adapters connected');
        }
      } catch (error) {
        handleError(error);
      }
    });

  gateway
    .command('reload')
    .description('Reload gateway configuration')
    .action(async () => {
      try {
        await reloadDaemon();
      } catch (error) {
        handleError(error);
      }
    });

  gateway
    .command('logs')
    .description('View gateway logs')
    .option('--follow, -f', 'Follow log output')
    .option('--lines <n>', 'Number of lines to show', '50')
    .action(async (options) => {
      try {
        if (!existsSync(LOG_FILE)) {
          console.log('No log file found');
          return;
        }

        if (options.follow) {
          // Tail -f equivalent
          const tailProcess = Bun.spawn(['tail', '-f', LOG_FILE], {
            stdout: 'inherit',
            stderr: 'inherit',
          });

          process.on('SIGINT', () => {
            tailProcess.kill();
            process.exit(0);
          });

          await tailProcess.exited;
        } else {
          // Read last N lines
          const lines = parseInt(options.lines, 10) || 50;
          const tailProcess = Bun.spawn(['tail', `-${lines}`, LOG_FILE], {
            stdout: 'inherit',
            stderr: 'inherit',
          });
          await tailProcess.exited;
        }
      } catch (error) {
        handleError(error);
      }
    });

  // Profile subcommands
  const profile = gateway.command('profile').description('Manage gateway identity');

  profile
    .command('add')
    .description('Create gateway identity with secret key')
    .option('--name <name>', 'Gateway name', 'default')
    .option('--secret <secret>', 'Use specific secret (otherwise auto-generated)')
    .action(async (options) => {
      try {
        const config = await loadConfig() as Config;

        if (config.gateway?.name) {
          throw new CliError('INVALID_PARAMS', `Gateway already configured: ${config.gateway.name}`, 'Use "gateway profile remove" first to reconfigure');
        }

        // Generate or use provided secret
        const secret = options.secret || `gw_${randomBytes(24).toString('base64url')}`;

        config.gateway = {
          ...config.gateway,
          name: options.name,
          secret,
          api: {
            ...config.gateway?.api,
            secret, // Also set as API secret
          },
        };

        await saveConfig(config);

        console.log(`Gateway profile created`);
        console.log(`  Name: ${options.name}`);
        console.log(`  Secret: ${secret}`);
        console.log(`\nThis secret will be included in "agentio config export"`);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('Show gateway identity')
    .action(async () => {
      try {
        const config = await loadConfig() as Config;

        if (!config.gateway?.name) {
          console.log('No gateway configured');
          console.log('Run: agentio gateway profile add --name <name>');
          return;
        }

        console.log('Gateway Profile');
        console.log(`  Name: ${config.gateway.name}`);
        console.log(`  Secret: ${config.gateway.secret ? config.gateway.secret.slice(0, 10) + '...' : '(not set)'}`);
        console.log(`  API Port: ${config.gateway.api?.port || 7890}`);
        console.log(`  API Host: ${config.gateway.api?.host || '127.0.0.1'}`);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove gateway identity')
    .action(async () => {
      try {
        const config = await loadConfig() as Config;

        if (!config.gateway?.name) {
          console.log('No gateway configured');
          return;
        }

        const name = config.gateway.name;
        delete config.gateway.name;
        delete config.gateway.secret;
        if (config.gateway.api) {
          delete config.gateway.api.secret;
        }

        await saveConfig(config);
        console.log(`Gateway profile "${name}" removed`);
      } catch (error) {
        handleError(error);
      }
    });

  // Teleport command
  gateway
    .command('teleport')
    .description('Transfer auth state to remote gateway')
    .argument('<url>', 'Remote gateway URL (e.g., https://my-gateway.com)')
    .option('--service <service>', 'Service to teleport (default: all)', 'all')
    .action(async (url: string, options) => {
      try {
        const config = await loadConfig() as Config;

        if (!config.gateway?.secret) {
          throw new CliError('CONFIG_ERROR', 'No gateway secret configured', 'Run: agentio gateway profile add');
        }

        console.log(`Teleporting to ${url}...`);

        // Export WhatsApp auth state
        if (options.service === 'all' || options.service === 'whatsapp') {
          const profiles = config.profiles.whatsapp || [];

          for (const entry of profiles) {
            const profileName = typeof entry === 'string' ? entry : entry.name;
            console.log(`  Exporting whatsapp:${profileName}...`);
            const authState = await exportWhatsAppAuthState(profileName);

            if (!authState) {
              console.log(`    No auth state found, skipping`);
              continue;
            }

            // Send to remote gateway
            const response = await fetch(`${url}/import/whatsapp/${encodeURIComponent(profileName)}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.gateway.secret}`,
              },
              body: JSON.stringify(authState),
            });

            if (!response.ok) {
              const error = await response.text();
              throw new CliError('API_ERROR', `Failed to import to remote: ${error}`);
            }

            console.log(`    Transferred successfully`);
          }
        }

        console.log('\nTeleport complete!');
        console.log('You can now stop the local gateway and use the remote one.');
      } catch (error) {
        handleError(error);
      }
    });
}
