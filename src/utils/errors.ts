export type ErrorCode =
  | 'AUTH_FAILED'
  | 'TOKEN_EXPIRED'
  | 'PROFILE_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFIG_ERROR';

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
    case 'TOKEN_EXPIRED':
    case 'PERMISSION_DENIED':
      return 2;
    case 'CONFIG_ERROR':
    case 'PROFILE_NOT_FOUND':
      return 3;
    case 'NETWORK_ERROR':
      return 4;
    case 'API_ERROR':
    case 'RATE_LIMITED':
    case 'NOT_FOUND':
      return 5;
    default:
      return 1;
  }
}

export function handleError(error: unknown): never {
  if (error instanceof CliError) {
    console.error(`Error [${error.code}]: ${error.message}`);
    if (error.suggestion) {
      console.error(`Suggestion: ${error.suggestion}`);
    }
    process.exit(exitCodeForError(error.code));
  }

  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  console.error('An unexpected error occurred');
  process.exit(1);
}
