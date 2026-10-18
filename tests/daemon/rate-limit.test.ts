import { describe, expect, test } from 'bun:test';
import { RateLimiter, clientIp } from '../../src/daemon/rate-limit';

describe('RateLimiter', () => {
  test('allows up to the limit inside a window, then refuses', () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('a', 10)).toBe(true);
    expect(rl.allow('a', 20)).toBe(true);
    expect(rl.allow('a', 30)).toBe(false);
    expect(rl.allow('a', 999)).toBe(false);
  });

  test('a new window starts the count over', () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('a', 500)).toBe(false);
    expect(rl.allow('a', 1000)).toBe(true);
  });

  test('keys are independent', () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('b', 0)).toBe(true);
    expect(rl.allow('a', 1)).toBe(false);
  });

  test('reset forgets all counts', () => {
    const rl = new RateLimiter(1, 1000);
    rl.allow('a', 0);
    rl.reset();
    expect(rl.allow('a', 1)).toBe(true);
  });
});

describe('RateLimiter per-caller limits', () => {
  test('a limit passed to allow overrides the default for that call', () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.allow('a', 0, 3)).toBe(true);
    expect(rl.allow('a', 1, 3)).toBe(true);
    expect(rl.allow('a', 2, 3)).toBe(true);
    expect(rl.allow('a', 3, 3)).toBe(false);
    // The default still applies to callers that pass none.
    expect(rl.allow('b', 0)).toBe(true);
    expect(rl.allow('b', 1)).toBe(false);
  });

  test('null or 0 is unlimited, and is not counted', () => {
    const rl = new RateLimiter(2, 1000);
    for (let i = 0; i < 10_000; i++) expect(rl.allow('a', i % 999, null)).toBe(true);
    for (let i = 0; i < 100; i++) expect(rl.allow('z', 0, 0)).toBe(true);
    // Back to a finite limit: the uncounted hits do not count against it.
    expect(rl.allow('a', 0, 2)).toBe(true);
    expect(rl.allow('a', 1, 2)).toBe(true);
    expect(rl.allow('a', 2, 2)).toBe(false);
  });

  test('lowering a limit applies inside the current window', () => {
    const rl = new RateLimiter(100, 1000);
    for (let i = 0; i < 5; i++) expect(rl.allow('a', i, 100)).toBe(true);
    expect(rl.allow('a', 6, 5)).toBe(false);
    expect(rl.allow('a', 7, 100)).toBe(true);
  });

  test('check names the limit that was hit', () => {
    const rl = new RateLimiter(1, 1000, (limit) => `More than ${limit} a minute`);
    rl.check('a', 0, 2);
    rl.check('a', 1, 2);
    expect(() => rl.check('a', 2, 2)).toThrow('More than 2 a minute');
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string> = {}) => new Request('http://x/', { headers });

  const withHeader = (name: string | undefined, fn: () => void) => {
    const prev = process.env.AGENTIO_TRUSTED_IP_HEADER;
    if (name === undefined) delete process.env.AGENTIO_TRUSTED_IP_HEADER;
    else process.env.AGENTIO_TRUSTED_IP_HEADER = name;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.AGENTIO_TRUSTED_IP_HEADER;
      else process.env.AGENTIO_TRUSTED_IP_HEADER = prev;
    }
  };

  test('ignores a client-supplied forwarded header when none is trusted', () => {
    withHeader(undefined, () => {
      // A spoofed X-Forwarded-For must not open a fresh bucket: the socket peer wins.
      expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }), '10.0.0.1')).toBe('10.0.0.1');
    });
  });

  test('uses the trusted header, taking the last (proxy-appended) token', () => {
    withHeader('x-forwarded-for', () => {
      expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), '10.0.0.1')).toBe('10.0.0.1');
    });
    withHeader('cf-connecting-ip', () => {
      expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.9' }), '10.0.0.1')).toBe('203.0.113.9');
    });
  });

  test('falls back to the socket peer when the trusted header is absent, then unknown', () => {
    withHeader('cf-connecting-ip', () => {
      expect(clientIp(req(), '10.0.0.7')).toBe('10.0.0.7');
      expect(clientIp(req(), null)).toBe('unknown');
    });
  });
});
