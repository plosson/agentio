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
 * The address to rate-limit on. A client-supplied `X-Forwarded-For` is
 * attacker-controlled — its leftmost token is whatever the client claimed — so
 * it is never trusted implicitly. When `AGENTIO_TRUSTED_IP_HEADER` names the
 * header the fronting proxy sets (e.g. `cf-connecting-ip` behind Cloudflare,
 * or `x-forwarded-for` behind a single appending proxy), its value is used,
 * taking the LAST comma token — the one the nearest trusted proxy appended,
 * never the leftmost. With no such config the socket peer is authoritative,
 * which is safe by default: a proxy that forwards without the env set collapses
 * every caller onto one bucket rather than trusting a spoofable header.
 */
export function clientIp(request: Request, socketAddress: string | null): string {
  const header = process.env.AGENTIO_TRUSTED_IP_HEADER?.toLowerCase().trim();
  if (header) {
    const raw = request.headers.get(header);
    if (raw) {
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
  }
  return socketAddress ?? 'unknown';
}
