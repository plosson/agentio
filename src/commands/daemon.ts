import { Command } from 'commander';
import { handleError } from '../utils/errors';
import { resolveDaemonAddress, startDaemon } from '../daemon/daemon';
import { getDaemonHealth, localDaemonUrl } from '../daemon/client';
import { checkDaemon, renderChecks } from './doctor';
import { addExamples } from '../utils/command-tree';
import { addJsonOption, printJson } from '../utils/output';

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Run or probe the local HTTP daemon');

  const startCmd = daemon
    .command('start')
    .description('Run the daemon in the foreground')
    .option('--host <host>', 'Interface to listen on (default: AGENTIO_DAEMON_HOST, else 0.0.0.0)')
    .option('--port <port>', 'Port to listen on, 0 for a free one (default: AGENTIO_DAEMON_PORT, else 7890)');
  addJsonOption(startCmd, 'Print a JSON event once listening; the log goes to stderr')
    .action(async (options: { host?: string; port?: string; json?: boolean }) => {
      try {
        const address = resolveDaemonAddress(options);
        await startDaemon({ version: program.version() ?? 'unknown', address, json: options.json });
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    startCmd,
    `Examples:

  # run the daemon in the foreground (Docker CMD, or a terminal for dev)
  agentio daemon start

  # listen on this machine only, on a free port, and report it as JSON
  agentio daemon start --host 127.0.0.1 --port 0 --json`,
  );

  const statusCmd = daemon
    .command('status')
    .description('Show daemon status');
  addJsonOption(statusCmd)
    .action(async (options: { json?: boolean }) => {
      try {
        if (options.json) {
          const url = localDaemonUrl();
          const health = await getDaemonHealth(url);
          printJson(
            health
              ? { event: 'daemon', running: true, url, locked: health.locked, uptime: health.uptime }
              : { event: 'daemon', running: false, url },
          );
          return;
        }
        console.log(renderChecks([await checkDaemon()]));
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    statusCmd,
    `Examples:

  # show whether the daemon is running
  agentio daemon status

  # the same, with its URL, as JSON for programs
  agentio daemon status --json`,
  );
}
