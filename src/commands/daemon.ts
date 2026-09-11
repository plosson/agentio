import { Command } from 'commander';
import { handleError } from '../utils/errors';
import { startDaemon } from '../daemon/daemon';
import { checkDaemon, renderChecks } from './doctor';
import { addExamples } from '../utils/command-tree';

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Run or probe the local HTTP daemon');

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
        console.log(renderChecks([await checkDaemon()]));
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
