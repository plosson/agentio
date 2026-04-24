import { Command } from 'commander';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'bun';
import { randomBytes } from 'crypto';
import { password } from '@inquirer/prompts';
import { handleError, CliError } from '../utils/errors';
import { loadConfig, saveConfig } from '../config/config-manager';
import { startGateway, getGatewayConfig, LOG_FILE } from '../daemon/daemon';
import { initDatabase, closeDatabase, exportWhatsAppAuthState } from '../daemon/store';
import { isInteractive } from '../utils/interactive';
import type { Config } from '../types/config';

const SERVICE_NAME = 'agentio-gateway';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;

/**
 * Find the agentio binary path
 */
function findBinaryPath(): string {
  const candidates = [
    '/usr/local/bin/agentio',
    join(process.env.HOME || '', '.local/bin/agentio'),
    process.argv[1],
  ];

  for (const path of candidates) {
    if (path && existsSync(path)) {
      const result = spawnSync({ cmd: ['realpath', path], stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode === 0) {
        return result.stdout.toString().trim();
      }
      return path;
    }
  }

  throw new Error('Could not find agentio binary');
}

/**
 * Check if systemd service is installed
 */
function isServiceInstalled(): boolean {
  return existsSync(SERVICE_FILE);
}

/**
 * Check if running as root or with sudo
 */
function checkRoot(): { isRoot: boolean; canSudo: boolean } {
  const whoami = spawnSync({ cmd: ['whoami'], stdout: 'pipe' });
  const isRoot = whoami.stdout.toString().trim() === 'root';

  if (isRoot) return { isRoot: true, canSudo: true };

  const sudoCheck = spawnSync({ cmd: ['sudo', '-n', 'true'], stdout: 'pipe', stderr: 'pipe' });
  return { isRoot: false, canSudo: sudoCheck.exitCode === 0 };
}

/**
 * Run a command with optional sudo
 */
function runCommand(cmd: string[], useSudo: boolean): { success: boolean; output: string; error: string } {
  const fullCmd = useSudo ? ['sudo', ...cmd] : cmd;
  const result = spawnSync({ cmd: fullCmd, stdout: 'pipe', stderr: 'pipe' });
  return {
    success: result.exitCode === 0,
    output: result.stdout.toString(),
    error: result.stderr.toString(),
  };
}

/**
 * Generate systemd service file content
 */
function generateServiceFile(binaryPath: string, configDir: string): string {
  return `[Unit]
Description=agentio gateway - messaging bridge for WhatsApp and Telegram
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath} gateway start --foreground
Restart=always
RestartSec=5
Environment=HOME=${process.env.HOME}

[Install]
WantedBy=multi-user.target
`;
}

export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command('gateway')
    .description('Gateway daemon management');

  // Install command - creates systemd service
  gateway
    .command('install')
    .description('Install gateway as a systemd service')
    .action(async () => {
      try {
        console.log('Installing agentio-gateway service...\n');

        // Check privileges
        const { isRoot, canSudo } = checkRoot();
        if (!isRoot && !canSudo) {
          console.log('This command requires sudo privileges.');
          console.log('Run with: sudo agentio gateway install');
          process.exit(1);
        }
        const useSudo = !isRoot;

        // Find binary
        let binaryPath: string;
        try {
          binaryPath = findBinaryPath();
        } catch {
          throw new CliError('CONFIG_ERROR', 'Could not find agentio binary');
        }

        console.log(`Binary: ${binaryPath}`);

        // Generate API key if not exists
        const config = await loadConfig() as Config;
        if (!config.gateway?.apiKey) {
          const apiKey = `gw_${randomBytes(24).toString('base64url')}`;
          config.gateway = { ...config.gateway, apiKey };
          await saveConfig(config);
          console.log(`Generated API key: ${apiKey}`);
        } else {
          console.log(`API key: ${config.gateway.apiKey.slice(0, 10)}...`);
        }

        // Create service file
        console.log('\nCreating systemd service...');
        const serviceContent = generateServiceFile(binaryPath, process.env.HOME + '/.config/agentio');
        const tempFile = `/tmp/${SERVICE_NAME}.service`;
        writeFileSync(tempFile, serviceContent);

        const copyResult = runCommand(['cp', tempFile, SERVICE_FILE], useSudo);
        if (!copyResult.success) {
          throw new CliError('CONFIG_ERROR', `Failed to create service file: ${copyResult.error}`);
        }

        // Reload systemd and enable service
        console.log('Enabling service...');
        const commands = [
          ['systemctl', 'daemon-reload'],
          ['systemctl', 'enable', SERVICE_NAME],
        ];

        for (const cmd of commands) {
          const result = runCommand(cmd, useSudo);
          if (!result.success) {
            throw new CliError('CONFIG_ERROR', `Command failed: ${cmd.join(' ')}`);
          }
        }

        // Start the service
        console.log('Starting gateway...');
        const startResult = runCommand(['systemctl', 'start', SERVICE_NAME], useSudo);
        if (!startResult.success) {
          throw new CliError('CONFIG_ERROR', `Failed to start service: ${startResult.error}`);
        }

        // Wait and check status
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResult = spawnSync({ cmd: ['systemctl', 'is-active', SERVICE_NAME], stdout: 'pipe' });

        if (statusResult.stdout.toString().trim() !== 'active') {
          console.log('\nService failed to start. Check logs with:');
          console.log('  journalctl -u agentio-gateway -f');
          process.exit(1);
        }

        console.log('\nagentio-gateway installed and running!');
        console.log('\nManage with:');
        console.log('  agentio gateway status');
        console.log('  agentio gateway stop');
        console.log('  agentio gateway restart');
        console.log('  agentio gateway logs');
      } catch (error) {
        handleError(error);
      }
    });

  // Start command - either via systemd or direct
  gateway
    .command('start')
    .description('Start the gateway')
    .option('--foreground', 'Run in foreground (used by systemd)')
    .action(async (options) => {
      try {
        if (options.foreground) {
          // Run directly in foreground (called by systemd or for dev)
          await startGateway();
        } else if (isServiceInstalled()) {
          // Use systemctl
          const { isRoot } = checkRoot();
          const result = runCommand(['systemctl', 'start', SERVICE_NAME], !isRoot);
          if (!result.success) {
            throw new CliError('CONFIG_ERROR', `Failed to start: ${result.error}`);
          }
          console.log('Gateway started');
        } else {
          // Run directly in foreground (for dev or when not installed as service)
          await startGateway();
        }
      } catch (error) {
        handleError(error);
      }
    });

  // Stop command
  gateway
    .command('stop')
    .description('Stop the gateway')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('Gateway service not installed');
          console.log('Run: agentio gateway install');
          return;
        }

        const { isRoot } = checkRoot();
        const result = runCommand(['systemctl', 'stop', SERVICE_NAME], !isRoot);
        if (!result.success) {
          throw new CliError('CONFIG_ERROR', `Failed to stop: ${result.error}`);
        }
        console.log('Gateway stopped');
      } catch (error) {
        handleError(error);
      }
    });

  // Restart command
  gateway
    .command('restart')
    .description('Restart the gateway')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('Gateway service not installed');
          console.log('Run: agentio gateway install');
          return;
        }

        const { isRoot } = checkRoot();
        const result = runCommand(['systemctl', 'restart', SERVICE_NAME], !isRoot);
        if (!result.success) {
          throw new CliError('CONFIG_ERROR', `Failed to restart: ${result.error}`);
        }
        console.log('Gateway restarted');
      } catch (error) {
        handleError(error);
      }
    });

  // Status command
  gateway
    .command('status')
    .description('Show gateway status')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('Gateway: not installed');
          console.log('Run: agentio gateway install');
          return;
        }

        // Check systemd status
        const statusResult = spawnSync({ cmd: ['systemctl', 'is-active', SERVICE_NAME], stdout: 'pipe' });
        const isActive = statusResult.stdout.toString().trim() === 'active';

        if (!isActive) {
          console.log('Gateway: stopped');
          return;
        }

        console.log('Gateway: running');

        // Try to get detailed status from API
        const gatewayConfig = await getGatewayConfig();
        const port = gatewayConfig.server?.port ?? 7890;

        try {
          const response = await fetch(`http://127.0.0.1:${port}/status`, {
            headers: gatewayConfig.apiKey ? { 'X-API-Key': gatewayConfig.apiKey } : {},
          });

          if (response.ok) {
            const data = await response.json() as { adapters: { service: string; profile: string; connected: boolean }[] };

            if (data.adapters && data.adapters.length > 0) {
              console.log('\nConnected adapters:');
              for (const adapter of data.adapters) {
                const icon = adapter.connected ? '✓' : '✗';
                console.log(`  ${icon} ${adapter.service}:${adapter.profile}`);
              }
            } else {
              console.log('\nNo adapters connected');
            }
          }
        } catch {
          // API not responding yet
        }
      } catch (error) {
        handleError(error);
      }
    });

  // Logs command
  gateway
    .command('logs')
    .description('View gateway logs')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .action(async (options) => {
      try {
        if (!isServiceInstalled()) {
          console.log('Gateway service not installed');
          return;
        }

        const args = ['journalctl', '-u', SERVICE_NAME, '--no-pager'];

        if (options.follow) {
          args.push('-f');
        } else {
          args.push('-n', options.lines);
        }

        const proc = Bun.spawn(args, {
          stdout: 'inherit',
          stderr: 'inherit',
        });

        if (options.follow) {
          process.on('SIGINT', () => {
            proc.kill();
            process.exit(0);
          });
        }

        await proc.exited;
      } catch (error) {
        handleError(error);
      }
    });

  // Uninstall command
  gateway
    .command('uninstall')
    .description('Remove gateway systemd service')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('Gateway service not installed');
          return;
        }

        const { isRoot } = checkRoot();
        const useSudo = !isRoot;

        console.log('Stopping and removing agentio-gateway service...');

        const commands = [
          ['systemctl', 'stop', SERVICE_NAME],
          ['systemctl', 'disable', SERVICE_NAME],
          ['rm', SERVICE_FILE],
          ['systemctl', 'daemon-reload'],
        ];

        for (const cmd of commands) {
          runCommand(cmd, useSudo);
        }

        console.log('Gateway service removed');
        console.log('\nNote: Configuration and data files are preserved in ~/.config/agentio/');
      } catch (error) {
        handleError(error);
      }
    });

  // Profile subcommands
  const profile = gateway.command('profile').description('Manage gateway connection');

  profile
    .command('add')
    .description('Configure connection to a gateway')
    .argument('<url>', 'Gateway URL (e.g., https://my-vps.com:7890)')
    .option('--name <name>', 'Profile name', 'default')
    .option('--api-key <key>', 'API key (will prompt if not provided)')
    .action(async (url: string, options) => {
      try {
        const config = await loadConfig() as Config;

        if (config.gateway?.apiUrl) {
          throw new CliError('INVALID_PARAMS', `Gateway already configured: ${config.gateway.apiUrl}`, 'Use "gateway profile remove" first to reconfigure');
        }

        let key = options.apiKey;

        // Prompt for API key if not provided
        if (!key) {
          if (!isInteractive()) {
            throw new CliError('INVALID_PARAMS', 'API key is required', 'Provide --api-key or run in an interactive terminal');
          }
          key = await password({
            message: 'Enter API key:',
            mask: '*',
          });
        }

        config.gateway = {
          ...config.gateway,
          name: options.name,
          apiUrl: url,
          apiKey: key,
        };

        await saveConfig(config);

        console.log('Gateway profile saved');
        console.log(`  Name: ${options.name}`);
        console.log(`  URL: ${url}`);
        console.log(`  API Key: ${key.slice(0, 10)}...`);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('Show gateway configuration')
    .action(async () => {
      try {
        const config = await loadConfig() as Config;

        if (!config.gateway?.apiUrl && !config.gateway?.apiKey) {
          console.log('No gateway configured');
          console.log('Run: agentio gateway profile add <url>');
          return;
        }

        console.log('Gateway Profile');
        if (config.gateway.name) {
          console.log(`  Name: ${config.gateway.name}`);
        }
        if (config.gateway.apiUrl) {
          console.log(`  URL: ${config.gateway.apiUrl}`);
        } else {
          // Local gateway: construct URL from server host:port
          const host = config.gateway.server?.host ?? '127.0.0.1';
          const port = config.gateway.server?.port ?? 7890;
          console.log(`  URL: http://${host}:${port} (local)`);
        }
        console.log(`  API Key: ${config.gateway.apiKey ? config.gateway.apiKey.slice(0, 10) + '...' : '(not set)'}`);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove gateway configuration')
    .action(async () => {
      try {
        const config = await loadConfig() as Config;

        if (!config.gateway?.apiUrl && !config.gateway?.apiKey) {
          console.log('No gateway configured');
          return;
        }

        const name = config.gateway?.name || config.gateway?.apiUrl || 'gateway';
        delete config.gateway?.name;
        delete config.gateway?.apiUrl;
        delete config.gateway?.apiKey;

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
    .option('--api-key <key>', 'Remote gateway API key (will prompt if not provided)')
    .option('--service <service>', 'Service to teleport (default: all)', 'all')
    .action(async (url: string, options) => {
      try {
        const config = await loadConfig() as Config;

        let key = options.apiKey || config.gateway?.apiKey;

        // Prompt for API key if not available
        if (!key) {
          if (!isInteractive()) {
            throw new CliError('INVALID_PARAMS', 'API key is required', 'Provide --api-key or configure gateway profile');
          }
          key = await password({
            message: 'Enter remote gateway API key:',
            mask: '*',
          });
        }

        console.log(`Teleporting to ${url}...`);

        // Export WhatsApp auth state
        if (options.service === 'all' || options.service === 'whatsapp') {
          const profiles = config.profiles.whatsapp || [];

          if (profiles.length > 0) {
            await initDatabase();
          }

          try {
            for (const entry of profiles) {
              const profileName = typeof entry === 'string' ? entry : entry.name;
              console.log(`  Exporting whatsapp:${profileName}...`);
              const authState = await exportWhatsAppAuthState(profileName);

              if (!authState) {
                console.log('    No auth state found, skipping');
                continue;
              }

              // Send to remote gateway
              const response = await fetch(`${url}/import/whatsapp/${encodeURIComponent(profileName)}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-API-Key': key,
                },
                body: JSON.stringify(authState),
              });

              if (!response.ok) {
                const error = await response.text();
                throw new CliError('API_ERROR', `Failed to import to remote: ${error}`);
              }

              console.log('    Transferred successfully');
            }
          } finally {
            closeDatabase();
          }
        }

        console.log('\nTeleport complete!');
        console.log('You can now stop the local gateway and use the remote one.');
      } catch (error) {
        handleError(error);
      }
    });
}
