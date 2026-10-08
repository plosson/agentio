import { describe, expect, test } from 'bun:test';
import { dirname } from 'path';
import { fakeSetupContext } from '../../../helpers/setup-context';
import { withTempVault } from '../../../helpers/vault';
import { spawnCli } from '../../../helpers/cli';
import { GDRIVE_ACCESS_INPUT, gdriveProfileAdd, gdriveReauthenticate } from '../../../../src/plugins/google/gdrive/commands';
import { SCOPES } from '../../../../src/plugins/google/oauth';
import { CliError } from '../../../../src/utils/errors';
import type { OAuthTokens } from '../../../../src/plugins/google/tokens';

const vault = withTempVault('agentio-gdrive-setup-', () => ({ config: { profiles: {} } as never }));

const TOKENS: OAuthTokens = { access_token: 'at', refresh_token: 'rt-new', expiry_date: 1234, token_type: 'Bearer', scope: 'a b' };

function stubs() {
  const services: string[] = [];
  const performOAuth = (async (service: string) => { services.push(service); return TOKENS; }) as never;
  const fetchEmail = (async () => 'a@b.c') as never;
  return { services, performOAuth, fetchEmail };
}

async function failure(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    return error as CliError;
  }
  throw new Error('expected a failure');
}

describe('gdriveProfileAdd', () => {
  test('--readonly together with --full is refused before any sign-in', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const context = fakeSetupContext({});
    const error = await failure(() => gdriveProfileAdd({ readonly: true, full: true }, context, performOAuth, fetchEmail));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toBe('Choose one of --readonly and --full');
    expect(services).toEqual([]);
    expect(context.asked).toEqual([]);
  });

  test('--read-only with --full is refused too', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const error = await failure(() => gdriveProfileAdd({ readOnly: true, full: true }, fakeSetupContext({}), performOAuth, fetchEmail));
    expect(error.code).toBe('INVALID_PARAMS');
    // The message names the flag that was given, not its other spelling.
    expect(error.message).toBe('Choose one of --read-only and --full');
    expect(services).toEqual([]);
  });

  test('an answer outside the choices is refused, with no sign-in', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const error = await failure(() => gdriveProfileAdd({}, fakeSetupContext({ Access: 'everything' }), performOAuth, fetchEmail));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toBe('Access must be one of: readonly, full');
    expect(services).toEqual([]);
  });

  test('--read-only wins over an access answer: nothing is asked, read-only scopes are used', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const context = fakeSetupContext({ Access: 'full' });
    const result = await gdriveProfileAdd({ readOnly: true }, context, performOAuth, fetchEmail);
    expect(context.asked).toEqual([]);
    expect(services).toEqual(['gdrive-readonly']);
    expect(result.credentials.accessLevel).toBe('readonly');
  });

  test('--full asks nothing and signs in with the full scopes', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const context = fakeSetupContext({});
    const result = await gdriveProfileAdd({ full: true }, context, performOAuth, fetchEmail);
    expect(context.asked).toEqual([]);
    expect(services).toEqual(['gdrive-full']);
    expect(result.credentials.accessLevel).toBe('full');
  });

  test('no flags: asks access once; the answer full signs in with gdrive-full', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const context = fakeSetupContext({ Access: 'full' });
    const result = await gdriveProfileAdd({}, context, performOAuth, fetchEmail);
    expect(context.asked).toEqual([GDRIVE_ACCESS_INPUT]);
    expect(services).toEqual(['gdrive-full']);
    expect(result.credentials).toEqual({
      accessToken: 'at', refreshToken: 'rt-new', expiryDate: 1234, tokenType: 'Bearer', scope: 'a b', email: 'a@b.c', accessLevel: 'full',
    });
    expect(result.suggestedProfileName).toBe('a@b.c');
    expect(result.info).toBe('Email: a@b.c\nAPI Access: Full (read & write)\nTest with: agentio gdrive list');
  });

  test('no flags: the answer readonly signs in read-only', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const result = await gdriveProfileAdd({}, fakeSetupContext({ Access: 'readonly' }), performOAuth, fetchEmail);
    expect(services).toEqual(['gdrive-readonly']);
    expect(result.info).toContain('API Access: Read-only');
  });
});

describe('gdrive reauthenticate', () => {
  test('redacted credentials (no refreshToken) with accessLevel full: signs in with gdrive-full and returns a new refreshToken', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const existing = { accessToken: '', expiryDate: 1, tokenType: 'Bearer', scope: 'x', email: 'old@b.c', accessLevel: 'full' } as never;
    const result = await gdriveReauthenticate(performOAuth, fetchEmail)(existing, 'p', fakeSetupContext({}));
    expect(services).toEqual(['gdrive-full']);
    expect(result.refreshToken).toBe('rt-new');
    expect(result.accessLevel).toBe('full');
    expect(result.email).toBe('a@b.c');
  });

  test('credentials without an access level default to read-only', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    await gdriveReauthenticate(performOAuth, fetchEmail)({ email: 'x@y.z' } as never, 'p', fakeSetupContext({}));
    expect(services).toEqual(['gdrive-readonly']);
  });
});

describe('gdrive profile add', () => {
  test('--full prints a Google address with the full Drive scope, opens no browser, and a denied callback is AUTH_FAILED', async () => {
    // Only bun on PATH: no browser opener can be found, so the address is printed instead.
    const run = spawnCli(['gdrive', 'profile', 'add', '--full'], { ...vault.env(), PATH: dirname(process.execPath) });
    const url = new URL((await run.printed(/visit:\n(\S+)/))[1]);
    const scope = url.searchParams.get('scope') ?? '';
    for (const wanted of SCOPES['gdrive-full']) expect(scope).toContain(wanted);
    expect(scope).not.toBe(SCOPES['gdrive-readonly'].join(' '));
    expect((await fetch(`${url.searchParams.get('redirect_uri')}?error=access_denied`)).status).toBe(200);
    const res = await run.finish();
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('No browser could be opened on this machine.');
    expect(res.stderr).toMatch(/Error \[AUTH_FAILED\]: .*access_denied/);
  }, 20_000);
});
