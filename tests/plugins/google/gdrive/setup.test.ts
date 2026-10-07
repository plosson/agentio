import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fakeSetupContext } from '../../../helpers/setup-context';
import { withTempVault } from '../../../helpers/vault';
import { runCli } from '../../../helpers/cli';
import { gdriveProfileAdd, gdriveReauthenticate } from '../../../../src/plugins/google/gdrive/commands';
import { GDRIVE_SETUP_NEEDS } from '../../../../src/plugins/google/setup-needs';
import { SCOPES } from '../../../../src/plugins/google/oauth';
import { CliError } from '../../../../src/utils/errors';
import type { OAuthTokens } from '../../../../src/plugins/google/tokens';

const vault = withTempVault('agentio-gdrive-json-', () => ({ config: { profiles: {} } as never }));

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
    const error = await failure(() => gdriveProfileAdd({}, fakeSetupContext({ access: 'everything' }), performOAuth, fetchEmail));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toBe('Access must be one of: readonly, full');
    expect(services).toEqual([]);
  });

  test('--read-only wins over an access answer: nothing is asked, read-only scopes are used', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const context = fakeSetupContext({ access: 'full' });
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
    const context = fakeSetupContext({ access: 'full' });
    const result = await gdriveProfileAdd({}, context, performOAuth, fetchEmail);
    expect(context.asked).toEqual([GDRIVE_SETUP_NEEDS.inputs[0]]);
    expect(services).toEqual(['gdrive-full']);
    expect(result.credentials).toEqual({
      accessToken: 'at', refreshToken: 'rt-new', expiryDate: 1234, tokenType: 'Bearer', scope: 'a b', email: 'a@b.c', accessLevel: 'full',
    });
    expect(result.suggestedProfileName).toBe('a@b.c');
    expect(result.info).toBe('Email: a@b.c\nAPI Access: Full (read & write)\nTest with: agentio gdrive list');
  });

  test('no flags: the answer readonly signs in read-only', async () => {
    const { services, performOAuth, fetchEmail } = stubs();
    const result = await gdriveProfileAdd({}, fakeSetupContext({ access: 'readonly' }), performOAuth, fetchEmail);
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

describe('gdrive profile add --json', () => {
  test('--describe --json prints exactly the needs', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'gdrive', 'profile', 'add', '--describe', '--json'], { stdout: 'pipe', stderr: 'pipe', env: vault.env() });
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({ v: 1, event: 'needs', service: 'gdrive', ...GDRIVE_SETUP_NEEDS });
  }, 20_000);

  test('an access value outside the choices is refused before anything opens', async () => {
    const res = await runCli(['gdrive', 'profile', 'add', '--json', '--input', '-'], vault.env(), ['{"access":"everything"}']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.map((e) => e.event)).toEqual(['error']);
    expect(res.events[0]).toMatchObject({ code: 'INVALID_PARAMS', message: 'Access must be one of: readonly, full' });
  }, 20_000);

  test('an unknown input id is refused', async () => {
    const res = await runCli(['gdrive', 'profile', 'add', '--json', '--input', '-'], vault.env(), ['{"x":"1"}']);
    expect(res.events.map((e) => e.event)).toEqual(['error']);
    expect(res.events[0].message).toContain('Unknown setup value "x"');
  }, 20_000);

  test('stdin closed with no access value gives No answer for "Access", never a hang', async () => {
    const res = await runCli(['gdrive', 'profile', 'add', '--json'], vault.env(), []);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Access"' });
  }, 20_000);

  test('--readonly --full is refused with one error and no open', async () => {
    const res = await runCli(['gdrive', 'profile', 'add', '--json', '--readonly', '--full'], vault.env(), []);
    expect(res.events.map((e) => e.event)).toEqual(['error']);
    expect(res.events[0]).toMatchObject({ code: 'INVALID_PARAMS', message: 'Choose one of --readonly and --full' });
  }, 20_000);

  test('{"access":"full"} prints an open URL with the full Drive scope and opens no browser', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'agentio-bin-'));
    const mark = join(bin, 'opened');
    for (const name of ['open', 'xdg-open']) {
      await writeFile(join(bin, name), `#!/bin/sh\necho "$@" > "${mark}"\n`);
      await chmod(join(bin, name), 0o755);
    }
    const env = { ...vault.env(), PATH: `${bin}:${process.env.PATH}` };
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'gdrive', 'profile', 'add', '--json', '--input', '-'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
    proc.stdin.write('{"access":"full"}\n');
    proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const event = JSON.parse(new TextDecoder().decode(value).split('\n')[0]);
    expect(event.event).toBe('open');
    const url = new URL(event.url);
    const scope = url.searchParams.get('scope') ?? '';
    for (const wanted of SCOPES['gdrive-full']) expect(scope).toContain(wanted);
    expect(scope).not.toBe(SCOPES['gdrive-readonly'].join(' '));
    const res = await fetch(`${url.searchParams.get('redirect_uri')}?error=access_denied`);
    expect(res.status).toBe(200);
    expect(await proc.exited).toBe(2);
    expect(existsSync(mark)).toBe(false);
  }, 20_000);
});
