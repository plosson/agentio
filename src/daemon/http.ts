import { CliError, type ErrorCode } from '../utils/errors';

/** How the CLI's error codes surface over HTTP. Anything unlisted is a 500. */
export const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  AUTH_FAILED: 401,
  PERMISSION_DENIED: 403,
  INVALID_PARAMS: 400,
  NOT_FOUND: 404,
  PROFILE_NOT_FOUND: 404,
  TOKEN_EXPIRED: 409,
  RATE_LIMITED: 429,
  VAULT_LOCKED: 503,
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof CliError) {
    return json(
      { error: err.message, code: err.code, ...(err.suggestion ? { suggestion: err.suggestion } : {}) },
      HTTP_STATUS[err.code] ?? 500,
    );
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  return json({ error: message, code: 'API_ERROR' }, 500);
}

/** Parsed JSON body; a bad or missing body is INVALID_PARAMS like any other bad input. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new CliError('INVALID_PARAMS', 'Body must be JSON');
  }
}
