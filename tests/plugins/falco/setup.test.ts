import { afterEach, describe, expect, test } from 'bun:test';
import { fakeSetupContext } from '../../helpers/setup-context';
import { withTempVault } from '../../helpers/vault';
import { falcoProfileAdd } from '../../../src/plugins/falco/commands';
import { reauthenticateFalco } from '../../../src/plugins/falco/lifecycle';
import falcoPlugin from '../../../src/plugins/falco';
import type { FalcoCredentials } from '../../../src/plugins/falco/types';
import type { CliError } from '../../../src/utils/errors';

withTempVault('agentio-falco-setup-', () => ({ config: { profiles: {} } as never }));
const PASSWORD = 'PW-SECRET-9f3';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TOKENS = { access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 600, refresh_token_expires_in: 86_400 };
const ORG_A = { id: 'org-a', name: 'Acme BV', vatNumber: 'BE0123' };
const ORG_B = { id: 'org-b', name: 'Beta NV' };

/** Falco's two hosts, faked. `twoFactor` is how many login calls answer "two_factor_required" first. */
function fakeFalco(options: { organizations?: unknown[]; twoFactor?: number } = {}) {
  const logins: Record<string, unknown>[] = [];
  const revoked: string[] = [];
  let remaining = options.twoFactor ?? 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/login')) {
      logins.push(JSON.parse(String(init?.body)));
      if (remaining > 0) {
        remaining--;
        return new Response(JSON.stringify({ error: 'two_factor_required' }), { status: 400 });
      }
      return new Response(JSON.stringify(TOKENS), { status: 200 });
    }
    if (url.endsWith('/revoke-refresh-token')) {
      revoked.push(JSON.parse(String(init?.body)).RefreshToken);
      return new Response('', { status: 200 });
    }
    if (url.endsWith('/user/me')) {
      return new Response(
        JSON.stringify({ id: 'u-1', email: 'me@acme.be', firstName: 'A', lastName: 'B', organizations: options.organizations ?? [ORG_A] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  return { logins, revoked };
}

async function failure(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    return error as CliError;
  }
  throw new Error('expected a failure');
}

const ANSWERS = { Email: 'me@acme.be', Password: PASSWORD };

describe('falcoProfileAdd', () => {
  test('a two-factor code asked again after one was given is AUTH_FAILED "still asking"', async () => {
    fakeFalco({ twoFactor: 2 });
    const error = await failure(() => falcoProfileAdd({}, fakeSetupContext({ ...ANSWERS, 'Two-factor code': '1' })));
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toBe('Falco is still asking for a two-factor code');
  });

  test('an organization id that is not among the choices is refused', async () => {
    fakeFalco({ organizations: [ORG_A, ORG_B] });
    const error = await failure(() => falcoProfileAdd({}, fakeSetupContext({ ...ANSWERS, Organization: 'org-zzz' })));
    expect(error.code).toBe('INVALID_PARAMS');
  });

  test('an empty email, or one that is not an address, is refused before any login', async () => {
    const { logins } = fakeFalco();
    for (const email of ['', 'not-an-email']) {
      const error = await failure(() => falcoProfileAdd({}, fakeSetupContext({ Email: email, Password: PASSWORD })));
      expect(error.code).toBe('INVALID_PARAMS');
    }
    expect(logins).toEqual([]);
  });

  test('no second factor, one organization: asks email and password only', async () => {
    fakeFalco();
    const context = fakeSetupContext(ANSWERS);
    const result = await falcoProfileAdd({}, context);
    expect(context.asked.map((spec) => spec.label)).toEqual(['Email', 'Password']);
    expect(result.credentials).toMatchObject({ organizationId: 'org-a', organizationName: 'Acme BV', refreshToken: 'ref-1' });
  });

  test('second factor required: asks the two-factor code and the second login carries it', async () => {
    const { logins } = fakeFalco({ twoFactor: 1 });
    const context = fakeSetupContext({ ...ANSWERS, 'Two-factor code': '123456' });
    await falcoProfileAdd({}, context);
    expect(context.asked.map((spec) => spec.label)).toEqual(['Email', 'Password', 'Two-factor code']);
    expect(logins.map((login) => login.twoFaCode)).toEqual([null, '123456']);
  });

  test('two organizations: asks organization with both ids; the second answer gives its id and name', async () => {
    fakeFalco({ organizations: [ORG_A, ORG_B] });
    const context = fakeSetupContext({ ...ANSWERS, Organization: 'org-b' });
    const result = await falcoProfileAdd({}, context);
    const asked = context.asked.find((spec) => spec.label === 'Organization')!;
    expect(asked.choices!.map((choice) => choice.value)).toEqual(['org-a', 'org-b']);
    expect(asked.choices![0]!.label).toBe('Acme BV — BE0123');
    expect(result.credentials).toMatchObject({ organizationId: 'org-b', organizationName: 'Beta NV' });
    expect(result.suggestedProfileName).toBe('beta-nv');
  });

  test('no organization at all is CONFIG_ERROR', async () => {
    fakeFalco({ organizations: [] });
    const error = await failure(() => falcoProfileAdd({}, fakeSetupContext(ANSWERS)));
    expect(error.code).toBe('CONFIG_ERROR');
  });

  test('the password is never logged', async () => {
    fakeFalco({ twoFactor: 1 });
    const context = fakeSetupContext({ ...ANSWERS, 'Two-factor code': '1' });
    const logged: string[] = [];
    context.log = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); };
    const result = await falcoProfileAdd({}, context);
    expect(logged.join('\n')).not.toContain(PASSWORD);
    expect(result.info ?? '').not.toContain(PASSWORD);
  });
});

describe('reauthenticateFalco', () => {
  // What a remote sign-in again receives: refreshToken is a secret field, so it is missing.
  const redacted = {
    refreshExpiryDate: 1,
    organizationId: 'org-a',
    organizationName: 'Old Name',
    userId: 'u-1',
    userEmail: 'me@acme.be',
  } as unknown as FalcoCredentials;

  test('credentials without refreshToken: asks only the password, keeps the organization, returns fresh tokens', async () => {
    const { logins, revoked } = fakeFalco();
    const context = fakeSetupContext({ Password: PASSWORD });
    const result = await reauthenticateFalco(redacted, 'acme', context);
    expect(context.asked.map((spec) => spec.label)).toEqual(['Password']);
    expect(logins[0]).toMatchObject({ userName: 'me@acme.be', password: PASSWORD });
    expect(result).toMatchObject({ organizationId: 'org-a', organizationName: 'Acme BV', refreshToken: 'ref-1', accessToken: 'acc-1' });
    expect(revoked).toEqual([]);
  });

  test('a stored refresh token is revoked after the new one validates', async () => {
    const { revoked } = fakeFalco();
    await reauthenticateFalco({ ...redacted, refreshToken: 'ref-old' }, 'acme', fakeSetupContext({ Password: PASSWORD }));
    expect(revoked).toEqual(['ref-old']);
  });

  test('second factor required: asks the two-factor code; required twice is "still asking"', async () => {
    const { logins } = fakeFalco({ twoFactor: 1 });
    const context = fakeSetupContext({ Password: PASSWORD, 'Two-factor code': '77' });
    await reauthenticateFalco(redacted, 'acme', context);
    expect(context.asked.map((spec) => spec.label)).toEqual(['Password', 'Two-factor code']);
    expect(logins[1]!.twoFaCode).toBe('77');

    fakeFalco({ twoFactor: 2 });
    const error = await failure(() => reauthenticateFalco(redacted, 'acme', fakeSetupContext({ Password: PASSWORD, 'Two-factor code': '77' })));
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toBe('Falco is still asking for a two-factor code');
  });

  test('no credentials is AUTH_FAILED and nothing is asked', async () => {
    const context = fakeSetupContext({});
    const error = await failure(() => reauthenticateFalco(null, 'acme', context));
    expect(error.code).toBe('AUTH_FAILED');
    expect(context.asked).toEqual([]);
  });

  test('the password is never logged', async () => {
    fakeFalco();
    const context = fakeSetupContext({ Password: PASSWORD });
    const logged: string[] = [];
    context.log = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); };
    await reauthenticateFalco(redacted, 'acme', context);
    expect(logged.join('\n')).not.toContain(PASSWORD);
  });
});

describe('falco plugin', () => {
  test('the plugin declares reauthenticate', () => {
    expect(falcoPlugin.profile?.reauthenticate).toBeFunction();
  });
});
