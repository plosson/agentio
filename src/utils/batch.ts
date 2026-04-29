export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.status === 'number') return e.status;
  if (e.response && typeof e.response.status === 'number') return e.response.status;
  return undefined;
}

function isQuotaExceeded(error: unknown): boolean {
  const status = getStatusCode(error);
  if (status !== 403) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /rateLimitExceeded|quotaExceeded|userRateLimitExceeded/i.test(message);
}

function isRetryable(error: unknown): boolean {
  const status = getStatusCode(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  if (isQuotaExceeded(error)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
  // 500ms, 1s, 2s, 4s, 8s with ±25% jitter
  const base = 500 * Math.pow(2, attempt);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function msUntilNextMinute(): number {
  const now = Date.now();
  return 60_000 - (now % 60_000) + 250;
}

export interface RetryOptions {
  maxRetries?: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !isRetryable(error)) {
        throw error;
      }
      const delay = isQuotaExceeded(error) ? msUntilNextMinute() : backoffDelay(attempt);
      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }

  throw lastError;
}
