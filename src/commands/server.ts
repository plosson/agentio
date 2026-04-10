import { Command } from 'commander';
import { existsSync, writeFileSync } from 'fs';
import { spawnSync } from 'bun';

import { handleError, CliError } from '../utils/errors';
import { loadConfig, saveConfig } from '../config/config-manager';
import { startServer } from '../server/daemon';
import type { Config } from '../types/config';
import type { ServerToken } from '../types/server';

/**
 * Validate a CLI-supplied port string. Must parse to an integer in [1, 65535].
 * Bun.serve happily accepts NaN / out-of-range / negative numbers and falls
 * back to a default port, which is a footgun — bail loudly instead.
 */
function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid --port: must be an integer in [1, 65535], got "${value}"`
    );
  }
  return n;
}

const SERVICE_NAME = 'agentio-server';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;

/**
 * Find the agentio binary path. Mirrors src/commands/gateway.ts.
 */
function findBinaryPath(): string {
  const candidates = [
    '/usr/local/bin/agentio',
    `${process.env.HOME || ''}/.local/bin/agentio`,
    process.argv[1],
  ];

  for (const path of candidates) {
    if (path && existsSync(path)) {
      const result = spawnSync({
        cmd: ['realpath', path],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (result.exitCode === 0) {
        return result.stdout.toString().trim();
      }
      return path;
    }
  }

  throw new Error('Could not find agentio binary');
}

function isServiceInstalled(): boolean {
  return existsSync(SERVICE_FILE);
}

function checkRoot(): { isRoot: boolean; canSudo: boolean } {
  const whoami = spawnSync({ cmd: ['whoami'], stdout: 'pipe' });
  const isRoot = whoami.stdout.toString().trim() === 'root';
  if (isRoot) return { isRoot: true, canSudo: true };

  const sudoCheck = spawnSync({
    cmd: ['sudo', '-n', 'true'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { isRoot: false, canSudo: sudoCheck.exitCode === 0 };
}

function runCommand(
  cmd: string[],
  useSudo: boolean
): { success: boolean; output: string; error: string } {
  const fullCmd = useSudo ? ['sudo', ...cmd] : cmd;
  const result = spawnSync({ cmd: fullCmd, stdout: 'pipe', stderr: 'pipe' });
  return {
    success: result.exitCode === 0,
    output: result.stdout.toString(),
    error: result.stderr.toString(),
  };
}

function generateServiceFile(binaryPath: string): string {
  return `[Unit]
Description=agentio HTTP MCP server
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath} server start --foreground
Restart=always
RestartSec=5
Environment=HOME=${process.env.HOME}

[Install]
WantedBy=multi-user.target
`;
}

export function registerServerCommands(program: Command): void {
  const server = program
    .command('server')
    .description('HTTP MCP server daemon management');

  // install — systemd integration
  server
    .command('install')
    .description('Install agentio server as a systemd service')
    .action(async () => {
      try {
        console.log('Installing agentio-server service...\n');

        const { isRoot, canSudo } = checkRoot();
        if (!isRoot && !canSudo) {
          console.log('This command requires sudo privileges.');
          console.log('Run with: sudo agentio server install');
          process.exit(1);
        }
        const useSudo = !isRoot;

        let binaryPath: string;
        try {
          binaryPath = findBinaryPath();
        } catch {
          throw new CliError('CONFIG_ERROR', 'Could not find agentio binary');
        }

        console.log(`Binary: ${binaryPath}`);

        console.log('\nCreating systemd service...');
        const serviceContent = generateServiceFile(binaryPath);
        const tempFile = `/tmp/${SERVICE_NAME}.service`;
        writeFileSync(tempFile, serviceContent);

        const copyResult = runCommand(
          ['cp', tempFile, SERVICE_FILE],
          useSudo
        );
        if (!copyResult.success) {
          throw new CliError(
            'CONFIG_ERROR',
            `Failed to create service file: ${copyResult.error}`
          );
        }

        console.log('Enabling service...');
        const commands = [
          ['systemctl', 'daemon-reload'],
          ['systemctl', 'enable', SERVICE_NAME],
        ];
        for (const cmd of commands) {
          const result = runCommand(cmd, useSudo);
          if (!result.success) {
            throw new CliError(
              'CONFIG_ERROR',
              `Command failed: ${cmd.join(' ')}`
            );
          }
        }

        console.log('Starting agentio server...');
        const startResult = runCommand(
          ['systemctl', 'start', SERVICE_NAME],
          useSudo
        );
        if (!startResult.success) {
          throw new CliError(
            'CONFIG_ERROR',
            `Failed to start service: ${startResult.error}`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResult = spawnSync({
          cmd: ['systemctl', 'is-active', SERVICE_NAME],
          stdout: 'pipe',
        });

        if (statusResult.stdout.toString().trim() !== 'active') {
          console.log('\nService failed to start. Check logs with:');
          console.log('  journalctl -u agentio-server -f');
          process.exit(1);
        }

        console.log('\nagentio-server installed and running!');
        console.log('\nManage with:');
        console.log('  agentio server status');
        console.log('  agentio server stop');
        console.log('  agentio server restart');
        console.log('  agentio server logs');
      } catch (error) {
        handleError(error);
      }
    });

  // start — foreground or via systemd
  server
    .command('start')
    .description('Start the agentio HTTP MCP server')
    .option('--foreground', 'Run in foreground (used by systemd or for dev)')
    .option('--port <n>', 'Port to bind (default: 9999)')
    .option('--host <host>', 'Host to bind (default: 0.0.0.0)')
    .option('--api-key <key>', 'Override the stored API key for this run only')
    .action(async (options) => {
      try {
        const port = options.port ? parsePort(options.port) : undefined;

        if (options.foreground) {
          await startServer({
            port,
            host: options.host,
            apiKey: options.apiKey,
          });
        } else if (isServiceInstalled()) {
          const { isRoot } = checkRoot();
          const result = runCommand(
            ['systemctl', 'start', SERVICE_NAME],
            !isRoot
          );
          if (!result.success) {
            throw new CliError(
              'CONFIG_ERROR',
              `Failed to start: ${result.error}`
            );
          }
          console.log('Server started');
        } else {
          await startServer({
            port,
            host: options.host,
            apiKey: options.apiKey,
          });
        }
      } catch (error) {
        handleError(error);
      }
    });

  // stop
  server
    .command('stop')
    .description('Stop the agentio server (systemd only)')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('agentio-server service not installed');
          console.log('Run: agentio server install');
          return;
        }
        const { isRoot } = checkRoot();
        const result = runCommand(
          ['systemctl', 'stop', SERVICE_NAME],
          !isRoot
        );
        if (!result.success) {
          throw new CliError('CONFIG_ERROR', `Failed to stop: ${result.error}`);
        }
        console.log('Server stopped');
      } catch (error) {
        handleError(error);
      }
    });

  // restart
  server
    .command('restart')
    .description('Restart the agentio server (systemd only)')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('agentio-server service not installed');
          console.log('Run: agentio server install');
          return;
        }
        const { isRoot } = checkRoot();
        const result = runCommand(
          ['systemctl', 'restart', SERVICE_NAME],
          !isRoot
        );
        if (!result.success) {
          throw new CliError(
            'CONFIG_ERROR',
            `Failed to restart: ${result.error}`
          );
        }
        console.log('Server restarted');
      } catch (error) {
        handleError(error);
      }
    });

  // status
  server
    .command('status')
    .description('Show agentio server status')
    .action(async () => {
      try {
        const config = (await loadConfig()) as Config;
        const port = config.server?.port ?? 9999;

        if (isServiceInstalled()) {
          const statusResult = spawnSync({
            cmd: ['systemctl', 'is-active', SERVICE_NAME],
            stdout: 'pipe',
          });
          const isActive =
            statusResult.stdout.toString().trim() === 'active';
          console.log(`Server: ${isActive ? 'running' : 'stopped'} (systemd)`);
        } else {
          // Try to probe /health on the configured port.
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) {
              console.log(`Server: running (foreground, port ${port})`);
            } else {
              console.log(`Server: not running`);
            }
          } catch {
            console.log('Server: not running');
          }
        }

        console.log(`API Key: ${
          config.server?.apiKey
            ? config.server.apiKey.slice(0, 12) + '...'
            : '(not set)'
        }`);
      } catch (error) {
        handleError(error);
      }
    });

  // logs
  server
    .command('logs')
    .description('View agentio server logs (systemd / journalctl)')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .action(async (options) => {
      try {
        if (!isServiceInstalled()) {
          console.log('agentio-server service not installed');
          console.log(
            'When running in --foreground, logs go to the terminal directly.'
          );
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

  // tokens — manage issued OAuth bearer tokens
  const tokens = server
    .command('tokens')
    .description('Manage issued OAuth bearer tokens');

  tokens
    .command('list')
    .description('List all issued bearer tokens')
    .action(async () => {
      try {
        const config = (await loadConfig()) as Config;
        const list = config.server?.tokens ?? [];
        if (list.length === 0) {
          console.log('No tokens issued yet.');
          return;
        }
        const fmt = (t: ServerToken) => {
          const issued = new Date(t.issuedAt).toISOString();
          const expires = new Date(t.expiresAt).toISOString();
          const expired = t.expiresAt < Date.now() ? ' (EXPIRED)' : '';
          const id = t.token.slice(0, 12);
          return `  ${id}…  client=${t.clientId}  scope=${t.scope || '(none)'}  issued=${issued}  expires=${expires}${expired}`;
        };
        console.log(`${list.length} token(s) issued:`);
        for (const t of list) {
          console.log(fmt(t));
        }
      } catch (error) {
        handleError(error);
      }
    });

  tokens
    .command('revoke')
    .description(
      'Revoke a token by its 12-character prefix or full opaque value'
    )
    .argument('<id>', 'Token id (first 12 chars) or full token value')
    .action(async (id: string) => {
      try {
        const config = (await loadConfig()) as Config;
        const list = config.server?.tokens ?? [];

        // Match either the full token value or any token whose value
        // starts with the given prefix.
        const matches = list.filter(
          (t) => t.token === id || t.token.startsWith(id)
        );

        if (matches.length === 0) {
          throw new CliError(
            'NOT_FOUND',
            `No token found matching "${id}"`,
            'Run `agentio server tokens list` to see issued tokens.'
          );
        }
        if (matches.length > 1) {
          throw new CliError(
            'INVALID_PARAMS',
            `Ambiguous prefix "${id}" matches ${matches.length} tokens`,
            'Use a longer prefix or the full token value.'
          );
        }

        const target = matches[0].token;
        const remaining = list.filter((t) => t.token !== target);
        config.server = {
          ...config.server,
          tokens: remaining,
        };
        await saveConfig(config);
        console.log(`Revoked token ${target.slice(0, 12)}…`);
        console.log(
          'Note: a running daemon caches tokens in memory and will continue to honor this one until restart.'
        );
      } catch (error) {
        handleError(error);
      }
    });

  tokens
    .command('clear')
    .description('Revoke ALL issued tokens (forces every client to re-auth)')
    .action(async () => {
      try {
        const config = (await loadConfig()) as Config;
        const count = config.server?.tokens?.length ?? 0;
        config.server = {
          ...config.server,
          tokens: [],
        };
        await saveConfig(config);
        console.log(`Cleared ${count} token(s).`);
        if (count > 0) {
          console.log(
            'Note: a running daemon caches tokens in memory and will continue to honor them until restart.'
          );
        }
      } catch (error) {
        handleError(error);
      }
    });

  // uninstall
  server
    .command('uninstall')
    .description('Remove agentio-server systemd service')
    .action(async () => {
      try {
        if (!isServiceInstalled()) {
          console.log('agentio-server service not installed');
          return;
        }

        const { isRoot } = checkRoot();
        const useSudo = !isRoot;

        console.log('Stopping and removing agentio-server service...');
        const commands = [
          ['systemctl', 'stop', SERVICE_NAME],
          ['systemctl', 'disable', SERVICE_NAME],
          ['rm', SERVICE_FILE],
          ['systemctl', 'daemon-reload'],
        ];
        for (const cmd of commands) {
          runCommand(cmd, useSudo);
        }

        console.log('agentio-server service removed');
        console.log(
          '\nNote: Configuration is preserved in ~/.config/agentio/config.json'
        );
      } catch (error) {
        handleError(error);
      }
    });
}
