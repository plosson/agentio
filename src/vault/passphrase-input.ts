import { CliError } from '../utils/errors';
import { readStdin } from '../utils/stdin';

export const MIN_PASSPHRASE_LEN = 8;

export interface PassphraseOptions {
  passphrase?: string;
  passphraseStdin?: boolean;
}

export function validatePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new CliError(
      'INVALID_PARAMS',
      `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`
    );
  }
}

/**
 * Resolution order: --passphrase-stdin, --passphrase, AGENTIO_PASSPHRASE, then
 * the caller's interactive prompt. Off a TTY the prompt would hang forever, so
 * that case errors instead.
 */
export async function resolvePassphrase(
  options: PassphraseOptions,
  promptFor: () => Promise<string>
): Promise<string> {
  if (options.passphrase && options.passphraseStdin) {
    throw new CliError('INVALID_PARAMS', '--passphrase and --passphrase-stdin are mutually exclusive');
  }

  if (options.passphraseStdin) {
    const piped = await readStdin();
    if (!piped) {
      throw new CliError(
        'INVALID_PARAMS',
        'No passphrase received on stdin',
        'Pipe it in, e.g. printf %s "$PW" | agentio vault set <path> --passphrase-stdin',
      );
    }
    return piped;
  }

  if (options.passphrase) return options.passphrase;
  if (process.env.AGENTIO_PASSPHRASE) return process.env.AGENTIO_PASSPHRASE;

  if (!process.stdin.isTTY) {
    throw new CliError(
      'INVALID_PARAMS',
      'A passphrase is required and no terminal is available to prompt',
      'Use --passphrase-stdin, --passphrase <value>, or set AGENTIO_PASSPHRASE',
    );
  }

  return promptFor();
}
