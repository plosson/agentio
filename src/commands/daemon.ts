import { Command } from 'commander';
import { handleError } from '../utils/errors';
import { startDaemon } from '../daemon/daemon';
import { isDaemonAvailable } from '../daemon/client';
import { addExamples } from '../utils/command-tree';

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Daemon lifecycle management (HTTP API server)');

  const startCmd = daemon
    .command('start')
    .description('Run the daemon in the foreground')
    .action(async () => {
      try {
        await startDaemon();
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    startCmd,
    `Examples:

  # run the daemon in the foreground (Docker CMD, or a terminal for dev)
  agentio daemon start`,
  );

  const statusCmd = daemon
    .command('status')
    .description('Show daemon status')
    .action(async () => {
      try {
        if (await isDaemonAvailable()) {
          console.log('Daemon: running');
        } else {
          console.log('Daemon: not running');
          console.log('Start it with: agentio daemon start');
        }
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    statusCmd,
    `Examples:

  # show whether the daemon is running
  agentio daemon status`,
  );
}
