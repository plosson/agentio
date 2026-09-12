import { CliError, type ErrorCode } from '../utils/errors';
import { ALL_SERVICES, type ServiceName } from '../types/config';

/** How the CLI's error codes surface over HTTP. Anything unlisted is a 500. */
const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
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

/**
 * `<prefix>/<service>/<name>[/<action>]` → the parts, or null when the path is
 * not that shape or names a service that does not exist.
 */
export function profilePath(
  pathname: string,
  prefix: string,
): { service: ServiceName; name: string; action: string | null } | null {
  if (!pathname.startsWith(prefix + '/')) return null;
  const parts = pathname.slice(prefix.length + 1).split('/');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) return null;
  const service = decodeURIComponent(parts[0]);
  if (!(ALL_SERVICES as readonly string[]).includes(service)) return null;
  return { service: service as ServiceName, name: decodeURIComponent(parts[1]), action: parts[2] ?? null };
}

/** Parsed JSON body; a bad or missing body is INVALID_PARAMS like any other bad input. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new CliError('INVALID_PARAMS', 'Body must be JSON');
  }
}
