import { constants } from 'os';
import { CliError } from '../../utils/errors';

/**
 * Run `command` with this process's environment plus `values` (which win),
 * sharing stdin, stdout and stderr. Returns the exit code to end with: the
 * child's own, or 128 + the signal number when a signal killed it, as a shell does.
 */
export async function runWithSecrets(command: string[], values: Map<string, string>): Promise<number> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(command, {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, ...Object.fromEntries(values) },
    });
  } catch (error) {
    throw new CliError(
      'NOT_FOUND',
      `Cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`,
      'Check the command name and PATH',
    );
  }
  const code = await child.exited;
  if (child.signalCode) return 128 + (constants.signals[child.signalCode as keyof typeof constants.signals] ?? 0);
  return code;
}
