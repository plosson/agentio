import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'bun';
import { randomBytes } from 'crypto';
import { password } from '@inquirer/prompts';
import plist from 'plist';
import { handleError, CliError } from '../utils/errors';
import { loadConfig, saveConfig } from '../config/config-manager';
import { startDaemon, getDaemonConfig, LOG_FILE } from '../daemon/daemon';
import { initDatabase, closeDatabase, exportWhatsAppAuthState } from '../daemon/store';
import { isInteractive } from '../utils/interactive';
import { buildDaemonPlist } from '../daemon/daemon-plist';
import { DAEMON_PLIST_FILE } from '../daemon/labels';
import type { Config } from '../types/config';

const SERVICE_NAME = 'agentio-daemon';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;
const LEGACY_SERVICE_NAME = 'agentio-gateway';
const LEGACY_SERVICE_FILE = `/etc/systemd/system/${LEGACY_SERVICE_NAME}.service`;

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
 * Check if systemd service is installed (new or legacy unit)
 */
function isServiceInstalled(): boolean {
  return existsSync(SERVICE_FILE) || existsSync(LEGACY_SERVICE_FILE);
}

/**
 * Return the name of the currently active service unit
 */
function activeServiceName(): string {
  return existsSync(SERVICE_FILE) ? SERVICE_NAME : LEGACY_SERVICE_NAME;
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
Description=agentio daemon - messaging connections and scheduler
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath} daemon start --foreground
Restart=always
RestartSec=5
Environment=HOME=${process.env.HOME}

[Install]
WantedBy=multi-user.target
`;
}

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const DAEMON_PLIST_PATH = join(LAUNCH_AGENTS_DIR, DAEMON_PLIST_FILE);
const DAEMON_LOG_PATH = join(homedir(), '.config', 'agentio', 'daemon.log');

function isDaemonInstalledDarwin(): boolean {
  return existsSync(DAEMON_PLIST_PATH);
}

function installDaemonDarwin(): void {
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }
  const binaryPath = findBinaryPath();
  const extraPath = existsSync('/opt/homebrew/bin') ? '/opt/homebrew/bin' : undefined;
  const dict = buildDaemonPlist({
    binaryPath,
    logPath: DAEMON_LOG_PATH,
    home: homedir(),
    extraPath,
  });
  writeFileSync(DAEMON_PLIST_PATH, plist.build(dict as unknown as plist.PlistObject));

  const uid = spawnSync({ cmd: ['id', '-u'], stdout: 'pipe' }).stdout.toString().trim();
  const bootstrap = spawnSync({
    cmd: ['launchctl', 'bootstrap', `gui/${uid}`, DAEMON_PLIST_PATH],
    stdout: 'pipe', stderr: 'pipe',
  });
  if (bootstrap.exitCode !== 0) {
    const fallback = spawnSync({
      cmd: ['launchctl', 'load', DAEMON_PLIST_PATH],
      stdout: 'pipe', stderr: 'pipe',
    });
    if (fallback.exitCode !== 0) {
      try { unlinkSync(DAEMON_PLIST_PATH); } catch { /* ignore */ }
      throw new CliError(
        'CONFIG_ERROR',
        `launchctl failed: ${fallback.stderr.toString() || bootstrap.stderr.toString()}`,
      );
    }
  }
}

function uninstallDaemonDarwin(): void {
  if (!existsSync(DAEMON_PLIST_PATH)) return;
  const uid = spawnSync({ cmd: ['id', '-u'], stdout: 'pipe' }).stdout.toString().trim();
  spawnSync({
    cmd: ['launchctl', 'bootout', `gui/${uid}/${DAEMON_PLIST_FILE.replace('.plist', '')}`],
    stdout: 'pipe', stderr: 'pipe',
  });
  spawnSync({ cmd: ['launchctl', 'unload', DAEMON_PLIST_PATH], stdout: 'pipe', stderr: 'pipe' });
  try { unlinkSync(DAEMON_PLIST_PATH); } catch { /* ignore */ }
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Daemon lifecycle management (messaging connections + scheduler)');

  // Install command - creates systemd service (Linux) or LaunchAgent (macOS)
  daemon
    .command('install')
    .description('Install daemon as a system service (launchd on macOS, systemd on Linux)')
    .action(async () => {
      try {
        if (process.platform === 'darwin') {
          console.log('Installing agentio daemon LaunchAgent...');
          const config = await loadConfig() as Config;
          if (!config.daemon?.apiKey) {
            const apiKey = `gw_${randomBytes(24).toString('base64url')}`;
            config.daemon = { ...config.daemon, apiKey };
            await saveConfig(config);
            console.log(`Generated API key: ${apiKey}`);
          }
          installDaemonDarwin();
          console.log('Installed and running via launchd.');
          console.log(`Plist:  ${DAEMON_PLIST_PATH}`);
          console.log(`Logs:   ${DAEMON_LOG_PATH}`);
          return;
        }
        if (process.platform === 'linux') {
          console.log('Installing agentio-daemon service...\n');

          // Check privileges
          const { isRoot, canSudo } = checkRoot();
          if (!isRoot && !canSudo) {
            console.log('This command requires sudo privileges.');
            console.log('Run with: sudo agentio daemon install');
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
          if (!config.daemon?.apiKey) {
            const apiKey = `gw_${randomBytes(24).toString('base64url')}`;
            config.daemon = { ...config.daemon, apiKey };
            await saveConfig(config);
            console.log(`Generated API key: ${apiKey}`);
          } else {
            console.log(`API key: ${config.daemon.apiKey.slice(0, 10)}...`);
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
          console.log('Starting daemon...');
          const startResult = runCommand(['systemctl', 'start', SERVICE_NAME], useSudo);
          if (!startResult.success) {
            throw new CliError('CONFIG_ERROR', `Failed to start service: ${startResult.error}`);
          }

          // Wait and check status
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const statusResult = spawnSync({ cmd: ['systemctl', 'is-active', SERVICE_NAME], stdout: 'pipe' });

          if (statusResult.stdout.toString().trim() !== 'active') {
            console.log('\nService failed to start. Check logs with:');
            console.log('  journalctl -u agentio-daemon -f');
            process.exit(1);
          }

          console.log('\nagentio-daemon installed and running!');
          console.log('\nManage with:');
          console.log('  agentio daemon status');
          console.log('  agentio daemon stop');
          console.log('  agentio daemon restart');
          console.log('  agentio daemon logs');
          return;
        }
        throw new CliError('CONFIG_ERROR',
          `agentio daemon install is not supported on ${process.platform}`,
          'Run the daemon manually with `agentio daemon start --foreground`');
      } catch (error) {
        handleError(error);
      }
    });

  // Start command - either via systemd or direct
  daemon
    .command('start')
    .description('Start the daemon')
    .option('--foreground', 'Run in foreground (used by systemd)')
    .action(async (options) => {
      try {
        if (options.foreground) {
          // Run directly in foreground (called by systemd or for dev)
          await startDaemon();
        } else if (isServiceInstalled()) {
          // Use systemctl
          const { isRoot } = checkRoot();
          const result = runCommand(['systemctl', 'start', activeServiceName()], !isRoot);
          if (!result.success) {
            throw new CliError('CONFIG_ERROR', `Failed to start: ${result.error}`);
          }
          console.log('Daemon started');
        } else {
          // Run directly in foreground (for dev or when not installed as service)
          await startDaemon();
        }
      } catch (error) {
        handleError(error);
      }
    });

  // Stop command
  daemon
    .command('stop')
    .description('Stop the daemon')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('Daemon service not installed');
          console.log('Run: agentio daemon install');
          return;
        }

        const { isRoot } = checkRoot();
        const result = runCommand(['systemctl', 'stop', activeServiceName()], !isRoot);
        if (!result.success) {
          throw new CliError('CONFIG_ERROR', `Failed to stop: ${result.error}`);
        }
        console.log('Daemon stopped');
      } catch (error) {
        handleError(error);
      }
    });

  // Restart command
  daemon
    .command('restart')
    .description('Restart the daemon')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('Daemon service not installed');
          console.log('Run: agentio daemon install');
          return;
        }

        const { isRoot } = checkRoot();
        const result = runCommand(['systemctl', 'restart', activeServiceName()], !isRoot);
        if (!result.success) {
          throw new CliError('CONFIG_ERROR', `Failed to restart: ${result.error}`);
        }
        console.log('Daemon restarted');
      } catch (error) {
        handleError(error);
      }
    });

  // Status command
  daemon
    .command('status')
    .description('Show daemon status')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('Daemon: not installed');
          console.log('Run: agentio daemon install');
          return;
        }

        // Check systemd status
        const statusResult = spawnSync({ cmd: ['systemctl', 'is-active', activeServiceName()], stdout: 'pipe' });
        const isActive = statusResult.stdout.toString().trim() === 'active';

        if (!isActive) {
          console.log('Daemon: stopped');
          return;
        }

        console.log('Daemon: running');

        // Try to get detailed status from API
        const gatewayConfig = await getDaemonConfig();
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
  daemon
    .command('logs')
    .description('View daemon logs')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .action(async (options) => {
      try {
        if (!isServiceInstalled()) {
          console.log('Daemon service not installed');
          return;
        }

        const args = ['journalctl', '-u', activeServiceName(), '--no-pager'];

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
  daemon
    .command('uninstall')
    .description('Remove daemon system service (launchd on macOS, systemd on Linux)')
    .action(async () => {
      try {
        if (process.platform === 'darwin') {
          if (!isDaemonInstalledDarwin()) {
            console.log('Daemon LaunchAgent not installed');
            return;
          }
          console.log('Removing agentio daemon LaunchAgent...');
          uninstallDaemonDarwin();
          console.log('Daemon LaunchAgent removed');
          console.log('\nNote: Configuration and data files are preserved in ~/.config/agentio/');
          return;
        }
        if (process.platform === 'linux') {
          if (!isServiceInstalled()) {
            console.log('Daemon service not installed');
            return;
          }

          const { isRoot } = checkRoot();
          const useSudo = !isRoot;

          const active = activeServiceName();
          const activeFile = active === SERVICE_NAME ? SERVICE_FILE : LEGACY_SERVICE_FILE;
          console.log(`Stopping and removing ${active} service...`);

          const commands = [
            ['systemctl', 'stop', active],
            ['systemctl', 'disable', active],
            ['rm', activeFile],
            ['systemctl', 'daemon-reload'],
          ];

          for (const cmd of commands) {
            runCommand(cmd, useSudo);
          }

          console.log('Daemon service removed');
          console.log('\nNote: Configuration and data files are preserved in ~/.config/agentio/');
          return;
        }
        throw new CliError('CONFIG_ERROR',
          `agentio daemon uninstall is not supported on ${process.platform}`,
          'Run the daemon manually with `agentio daemon start --foreground`');
      } catch (error) {
        handleError(error);
      }
    });

  // Profile subcommands
  const profile = daemon.command('profile').description('Manage daemon connection');

  profile
    .command('add')
    .description('Configure connection to a daemon')
    .argument('<url>', 'Daemon URL (e.g., https://my-vps.com:7890)')
    .option('--name <name>', 'Profile name', 'default')
    .option('--api-key <key>', 'API key (will prompt if not provided)')
    .action(async (url: string, options) => {
      try {
        const config = await loadConfig() as Config;

        if (config.daemon?.apiUrl) {
          throw new CliError('INVALID_PARAMS', `Daemon already configured: ${config.daemon.apiUrl}`, 'Use "daemon profile remove" first to reconfigure');
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

        config.daemon = {
          ...config.daemon,
          name: options.name,
          apiUrl: url,
          apiKey: key,
        };

        await saveConfig(config);

        console.log('Daemon profile saved');
        console.log(`  Name: ${options.name}`);
        console.log(`  URL: ${url}`);
        console.log(`  API Key: ${key.slice(0, 10)}...`);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('Show daemon configuration')
    .action(async () => {
      try {
        const config = await loadConfig() as Config;

        if (!config.daemon?.apiUrl && !config.daemon?.apiKey) {
          console.log('No daemon configured');
          console.log('Run: agentio daemon profile add <url>');
          return;
        }

        console.log('Daemon Profile');
        if (config.daemon.name) {
          console.log(`  Name: ${config.daemon.name}`);
        }
        if (config.daemon.apiUrl) {
          console.log(`  URL: ${config.daemon.apiUrl}`);
        } else {
          // Local daemon: construct URL from server host:port
          const host = config.daemon.server?.host ?? '127.0.0.1';
          const port = config.daemon.server?.port ?? 7890;
          console.log(`  URL: http://${host}:${port} (local)`);
        }
        console.log(`  API Key: ${config.daemon.apiKey ? config.daemon.apiKey.slice(0, 10) + '...' : '(not set)'}`);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove daemon configuration')
    .action(async () => {
      try {
        const config = await loadConfig() as Config;

        if (!config.daemon?.apiUrl && !config.daemon?.apiKey) {
          console.log('No daemon configured');
          return;
        }

        const name = config.daemon?.name || config.daemon?.apiUrl || 'daemon';
        delete config.daemon?.name;
        delete config.daemon?.apiUrl;
        delete config.daemon?.apiKey;

        await saveConfig(config);
        console.log(`Daemon profile "${name}" removed`);
      } catch (error) {
        handleError(error);
      }
    });

  // Teleport command
  daemon
    .command('teleport')
    .description('Transfer auth state to remote gateway')
    .argument('<url>', 'Remote gateway URL (e.g., https://my-gateway.com)')
    .option('--api-key <key>', 'Remote gateway API key (will prompt if not provided)')
    .option('--service <service>', 'Service to teleport (default: all)', 'all')
    .action(async (url: string, options) => {
      try {
        const config = await loadConfig() as Config;

        let key = options.apiKey || config.daemon?.apiKey;

        // Prompt for API key if not available
        if (!key) {
          if (!isInteractive()) {
            throw new CliError('INVALID_PARAMS', 'API key is required', 'Provide --api-key or configure daemon profile');
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
