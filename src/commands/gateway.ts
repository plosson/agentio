import { Command } from 'commander';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { handleError } from '../utils/errors';
import { startDaemon, stopDaemon, getDaemonStatus, reloadDaemon, LOG_FILE } from '../gateway/daemon';

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
}
