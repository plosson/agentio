import { CliError } from '../utils/errors';

/** Above this many tracked keys, the oldest is dropped on insert instead of scanning the map. */
const MAX_TRACKED = 1000;

/**
 * Fixed-window counter per key. Good enough to blunt passphrase guessing on
 * a public host; not a fairness scheduler.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly message = 'Too many attempts, try again in a minute',
  ) {}

  /** Records a hit and says whether it is within the limit. */
  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.delete(key);
      this.hits.set(key, { windowStart: now, count: 1 });
      if (this.hits.size > MAX_TRACKED) this.hits.delete(this.hits.keys().next().value!);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Records a hit and throws RATE_LIMITED when it is over the limit. */
  check(key: string, now = Date.now()): void {
    if (!this.allow(key, now)) throw new CliError('RATE_LIMITED', this.message);
  }

  reset(): void {
    this.hits.clear();
  }
}

/**
 * The address to rate-limit on. siteio fronts the daemon, so a forwarded
 * header wins when present; otherwise the socket peer.
 */
export function clientIp(request: Request, socketAddress: string | null): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return socketAddress ?? 'unknown';
}
