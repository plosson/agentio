import type { ServiceName } from '../types/config';
import { isJsonMode, printJson } from './output';

export type ErrorCode =
  | 'AUTH_FAILED'
  | 'AUTH_EXPIRED'
  | 'TOKEN_EXPIRED'
  | 'PROFILE_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED'
  | 'READ_ONLY_PROFILE'
  | 'PREMIUM_REQUIRED'
  | 'NO_ACTIVE_DEVICE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'NOT_FOUND'
  | 'CONFIG_ERROR'
  | 'VAULT_NOT_CONFIGURED'
  | 'VAULT_LOCKED'
  | 'VAULT_CORRUPT'
  | 'UNKNOWN_ERROR';

/**
 * Map HTTP status codes to standard error codes.
 * Use this in API clients to standardize error handling.
 */
export function httpStatusToErrorCode(status: number): ErrorCode {
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'API_ERROR';
}

export class CliError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function exitCodeForError(code: ErrorCode): number {
  switch (code) {
    case 'AUTH_FAILED':
    case 'AUTH_EXPIRED':
    case 'TOKEN_EXPIRED':
    case 'PERMISSION_DENIED':
    case 'READ_ONLY_PROFILE':
    case 'PREMIUM_REQUIRED':
    case 'VAULT_NOT_CONFIGURED':
    case 'VAULT_LOCKED':
    case 'VAULT_CORRUPT':
      return 2;
    case 'CONFIG_ERROR':
    case 'PROFILE_NOT_FOUND':
      return 3;
    case 'NETWORK_ERROR':
      return 4;
    case 'API_ERROR':
    case 'RATE_LIMITED':
    case 'QUOTA_EXCEEDED':
    case 'NOT_FOUND':
    case 'NO_ACTIVE_DEVICE':
      return 5;
    default:
      return 1;
  }
}

/** `text` with each secret replaced by `placeholder`; empty or missing secrets are skipped. */
export function redact(text: string, secrets: readonly (string | undefined)[], placeholder: string): string {
  return secrets.reduce<string>((t, secret) => (secret ? t.split(secret).join(placeholder) : t), text);
}

export function multipleProfilesError(service: ServiceName, names: string[]): CliError {
  const list = names.join(', ');
  return new CliError(
    'INVALID_PARAMS',
    `Multiple ${service} profiles exist: ${list}.`,
    `Use --profile <name> to pick one.`,
  );
}

export function profileNotFoundError(service: ServiceName, profile: string): CliError {
  return new CliError('PROFILE_NOT_FOUND', `No ${service} profile "${profile}"`, `Run: agentio ${service} profile list`);
}

export function noCredentialsError(service: ServiceName, profile: string): CliError {
  return new CliError(
    'AUTH_FAILED',
    `No credentials found for ${service} profile "${profile}"`,
    `Run: agentio ${service} profile add --profile ${profile}`,
  );
}

/** The refusal when a key may read a hub's credentials but not change which profiles it holds. */
export function cannotManageProfilesError(hubUrl?: string): CliError {
  return new CliError(
    'PERMISSION_DENIED',
    `This token may not manage profiles${hubUrl ? ` on the vault hub at ${hubUrl}` : ''}`,
    'Ask the hub owner to allow this key to manage profiles',
  );
}

/**
 * Print `error` for people or programs, then exit. `generalExitCode` replaces exit code 1, for a
 * command whose 1 already means an answer (`jev yesno`: 1 is "no").
 */
export function handleError(error: unknown, generalExitCode = 1): never {
  const isCliError = error instanceof CliError;
  let exitCode = generalExitCode;
  if (isCliError) {
    const n = exitCodeForError(error.code);
    exitCode = n === 1 ? generalExitCode : n;
  }

  if (isJsonMode()) {
    printJson(
      isCliError
        ? { event: 'error', code: error.code, message: error.message, suggestion: error.suggestion }
        : {
            event: 'error',
            code: 'UNKNOWN_ERROR',
            message: error instanceof Error ? error.message : 'An unexpected error occurred',
          },
    );
  } else if (isCliError) {
    console.error(`Error [${error.code}]: ${error.message}`);
    if (error.suggestion) console.error(`Suggestion: ${error.suggestion}`);
  } else {
    console.error(error instanceof Error ? `Error: ${error.message}` : 'An unexpected error occurred');
  }
  process.exit(exitCode);
}
