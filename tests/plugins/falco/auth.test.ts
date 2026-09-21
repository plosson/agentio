import { afterEach, describe, expect, test } from 'bun:test';
import { loginToFalco, refreshFalcoToken } from '../../../src/plugins/falco/auth';
import { CliError } from '../../../src/utils/errors';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(response: Response | (() => never)): void {
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    if (typeof response === 'function') response();
    return response as Response;
  }) as unknown as typeof fetch;
}

const TOKENS = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expires_in: 600,
  refresh_token_expires_in: 86_400,
};

describe('loginToFalco', () => {
  test('returns the tokens on success', async () => {
    stub(new Response(JSON.stringify(TOKENS), { status: 200 }));
    const result = await loginToFalco({ username: 'a@b.c', password: 'pw' });
    expect(result).toEqual({
      type: 'success',
      tokens: { accessToken: 'access-abc', refreshToken: 'refresh-xyz', expiresIn: 600, refreshTokenExpiresIn: 86_400 },
    });
  });

  test('never echoes a 200 body, because that body is the token payload', async () => {
    // A truncated success response still contains a live token. Slicing it into
    // the error message would print it to the terminal.
    stub(new Response('{"access_token":"eyJhbGciOi-LIVE-TOKEN', { status: 200 }));
    const error = (await loginToFalco({ username: 'a@b.c', password: 'pw' }).catch((e) => e)) as CliError;

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).not.toContain('LIVE-TOKEN');
    expect(error.message).not.toContain('eyJhbGciOi');
    expect(`${error.message} ${error.suggestion ?? ''}`).not.toContain('access_token');
  });

  test('rejects a 200 that is missing fields we persist', async () => {
    // Storing an undefined refresh token disables refresh permanently and
    // silently, so this must fail loudly instead.
    stub(new Response(JSON.stringify({ access_token: 'a', expires_in: 600 }), { status: 200 }));
    const error = (await loginToFalco({ username: 'a@b.c', password: 'pw' }).catch((e) => e)) as CliError;

    expect(error.code).toBe('API_ERROR');
    expect(error.message).toContain('refresh_token');
  });

  test('reports a required second factor rather than failing', async () => {
    stub(new Response(JSON.stringify({ error: 'two_factor_required' }), { status: 400 }));
    expect(await loginToFalco({ username: 'a@b.c', password: 'pw' })).toEqual({ type: 'two_factor_required' });
  });

  test('names bad credentials and a bad code instead of dumping a status', async () => {
    stub(new Response(JSON.stringify({ error: 'invalid_credentials' }), { status: 400 }));
    expect(((await loginToFalco({ username: 'a@b.c', password: 'x' }).catch((e) => e)) as CliError).message).toContain(
      'Invalid Falco credentials',
    );

    stub(new Response(JSON.stringify({ error: 'invalid_two_factor_code' }), { status: 400 }));
    const error = (await loginToFalco({ username: 'a@b.c', password: 'x', twoFaCode: '000' }).catch(
      (e) => e,
    )) as CliError;
    expect(error.message).toContain('two-factor code');
    // The flow does not retry in place, so the suggestion must not imply it does.
    expect(error.suggestion).toContain('Re-run');
  });

  test('never interpolates the password into an error', async () => {
    stub(new Response(JSON.stringify({ error: 'invalid_credentials' }), { status: 400 }));
    const error = (await loginToFalco({ username: 'a@b.c', password: 'hunter2' }).catch((e) => e)) as CliError;
    expect(`${error.message} ${error.suggestion ?? ''}`).not.toContain('hunter2');
  });

  test('maps a transport failure to NETWORK_ERROR', async () => {
    stub(() => {
      throw new TypeError('connect ECONNREFUSED');
    });
    expect(((await loginToFalco({ username: 'a@b.c', password: 'x' }).catch((e) => e)) as CliError).code).toBe(
      'NETWORK_ERROR',
    );
  });
});

describe('refreshFalcoToken', () => {
  test('returns the rotated token, not the one sent', async () => {
    stub(new Response(JSON.stringify({ ...TOKENS, refresh_token: 'rotated-new' }), { status: 200 }));
    const tokens = await refreshFalcoToken('refresh-old');
    expect(tokens.refreshToken).toBe('rotated-new');
  });

  test('rejects an incomplete refresh response instead of storing undefined', async () => {
    stub(new Response(JSON.stringify({ access_token: 'a', expires_in: 600 }), { status: 200 }));
    const error = (await refreshFalcoToken('refresh-old').catch((e) => e)) as CliError;
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toContain('refresh_token');
  });

  test('reports a rejected refresh as TOKEN_EXPIRED and points at reauth', async () => {
    stub(new Response('invalid_grant', { status: 400 }));
    const error = (await refreshFalcoToken('refresh-old').catch((e) => e)) as CliError;
    expect(error.code).toBe('TOKEN_EXPIRED');
    expect(error.suggestion).toContain('agentio reauth');
  });
});
