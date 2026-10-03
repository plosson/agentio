import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { loadVault } from '../../../src/vault/vault';
import { scopesFor, type OAuthService } from '../../../src/plugins/google/oauth';
import { GOOGLE_SUITE } from '../../../src/plugins/google/suite';
import { addGoogleProfiles, type GoogleGrantDeps } from '../../../src/plugins/google/group';
import { CliError } from '../../../src/utils/errors';

const OLD_GMAIL = { access_token: 'old', refresh_token: 'rt-old', token_type: 'Bearer', email: 'me@x.com' };

withTempVault('agentio-google-group-', () => ({
  config: { profiles: { gmail: [{ name: 'me@x.com', readOnly: true }] } },
  credentials: { gmail: { 'me@x.com': OLD_GMAIL } },
}));

let stderr: string[] = [];
let stdout: string[] = [];
let errorSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  stderr = [];
  stdout = [];
  errorSpy = spyOn(console, 'error').mockImplementation((m) => { stderr.push(String(m)); });
  logSpy = spyOn(console, 'log').mockImplementation((m) => { stdout.push(String(m)); });
});
afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

const keysOf = (keys: OAuthService | readonly OAuthService[]) => (typeof keys === 'string' ? [keys] : [...keys]);
const tokensWith = (scope: string | undefined) => ({ access_token: 'at-new', refresh_token: 'rt-new', expiry_date: 99, token_type: 'Bearer', scope });
/** Google grants exactly what was asked, unless `drop` names scopes the user unticked. */
const grantAll = (drop: string[] = []) =>
  mock(async (keys: OAuthService | readonly OAuthService[]) =>
    tokensWith(scopesFor(keysOf(keys)).filter((s) => !drop.includes(s)).join(' ')));
/** No network: the real Chat check is replaced by one that passes. */
const OFFLINE_SUITE = GOOGLE_SUITE.map((entry) => ({ ...entry, verify: undefined }));

function deps(overrides: GoogleGrantDeps = {}): GoogleGrantDeps {
  return {
    performOAuth: grantAll(),
    fetchEmail: mock(async () => 'me@x.com'),
    interactive: () => false,
    suite: OFFLINE_SUITE,
    ...overrides,
  };
}

describe('addGoogleProfiles: refused before the browser opens', () => {
  test('an unknown service', async () => {
    const d = deps();
    await expect(addGoogleProfiles({ services: ['gmail', 'gmial'] }, d)).rejects.toThrow('Unknown Google service: gmial');
    expect(d.performOAuth).not.toHaveBeenCalled();
  });

  test('an empty service list', async () => {
    const d = deps();
    await expect(addGoogleProfiles({ services: [] }, d)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(d.performOAuth).not.toHaveBeenCalled();
  });

  test('no service list and no terminal to ask in', async () => {
    const d = deps();
    await expect(addGoogleProfiles({}, d)).rejects.toThrow('--services');
    expect(d.performOAuth).not.toHaveBeenCalled();
  });

  test('a profile name that can never be saved', async () => {
    const d = deps();
    await expect(addGoogleProfiles({ services: ['gcal'], profile: 'a/b' }, d)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(d.performOAuth).not.toHaveBeenCalled();
  });
});

describe('addGoogleProfiles: one consent', () => {
  test('asks once for the joined scopes, and Drive is full unless read-only', async () => {
    const d = deps();
    await addGoogleProfiles({ services: ['gcal', 'gdrive', 'gcal'], profile: 'p1' }, d);
    await addGoogleProfiles({ services: ['gdrive'], profile: 'p2', readOnly: true }, d);
    expect((d.performOAuth as ReturnType<typeof mock>).mock.calls.map((c) => c[0])).toEqual([['gcal', 'gdrive-full'], ['gdrive-readonly']]);
  });

  test('every profile gets the same refresh token, in its own shape', async () => {
    await addGoogleProfiles({ services: ['gcal', 'gdocs', 'gdrive'], profile: 'work' }, deps());
    const { credentials } = await loadVault();
    expect(credentials.gcal?.work).toMatchObject({ refresh_token: 'rt-new', email: 'me@x.com' });
    expect(credentials.gdocs?.work).toMatchObject({ refreshToken: 'rt-new', email: 'me@x.com' });
    expect(credentials.gdrive?.work).toMatchObject({ refreshToken: 'rt-new', accessLevel: 'full' });
    expect(stdout).toEqual(['Profile "work" configured for gcal', 'Profile "work" configured for gdrive', 'Profile "work" configured for gdocs']);
  });

  test('the email cannot be fetched: nothing is saved', async () => {
    const before = await loadVault();
    const d = deps({ fetchEmail: mock(async () => { throw new Error('500'); }) });
    await expect(addGoogleProfiles({ services: ['gcal'] }, d)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(await loadVault()).toEqual(before);
  });
});

describe('addGoogleProfiles: Google grants less than asked', () => {
  test('only the services whose scopes were all granted are saved', async () => {
    const d = deps({ performOAuth: grantAll(['https://www.googleapis.com/auth/calendar']) });
    expect(await addGoogleProfiles({ services: ['gcal', 'gtasks'], profile: 'w' }, d)).toEqual(['gtasks/w']);
    const { config } = await loadVault();
    expect(config.profiles.gcal).toBeUndefined();
    expect(stderr.join('\n')).toContain('Skipped gcal: Google did not grant https://www.googleapis.com/auth/calendar');
  });

  test('nothing granted at all fails, and nothing is saved', async () => {
    const before = await loadVault();
    const d = deps({ performOAuth: mock(async () => tokensWith(undefined)) });
    await expect(addGoogleProfiles({ services: ['gcal', 'gtasks'] }, d)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(await loadVault()).toEqual(before);
  });

  test('Chat fails its Workspace check: the others are still saved', async () => {
    const suite = GOOGLE_SUITE.map((entry) => ({
      ...entry,
      verify: entry.service === 'gchat' ? async () => { throw new CliError('AUTH_FAILED', 'Workspace only'); } : undefined,
    }));
    expect(await addGoogleProfiles({ services: ['gchat', 'gtasks'], profile: 'w' }, deps({ suite }))).toEqual(['gtasks/w']);
    expect(stderr.join('\n')).toContain('Skipped gchat: Workspace only');
  });
});

describe('addGoogleProfiles: a profile with that name exists', () => {
  test('no terminal and no --force: refused after consent, nothing saved, clashes named', async () => {
    const before = await loadVault();
    await expect(addGoogleProfiles({ services: ['gmail', 'gcal'] }, deps())).rejects.toThrow('gmail/me@x.com');
    expect(await loadVault()).toEqual(before);
  });

  test('--force replaces it, keeps its read-only flag, and adds the rest', async () => {
    await addGoogleProfiles({ services: ['gmail', 'gcal'], force: true }, deps());
    const { config, credentials } = await loadVault();
    expect(config.profiles.gmail).toEqual([{ name: 'me@x.com', readOnly: true }]);
    expect(config.profiles.gcal).toEqual([{ name: 'me@x.com' }]);
    expect(credentials.gmail?.['me@x.com']).toMatchObject({ refresh_token: 'rt-new' });
  });

  test('in a terminal, answering no saves nothing', async () => {
    const before = await loadVault();
    const confirmReplace = mock(async () => false);
    const saved = await addGoogleProfiles({ services: ['gmail', 'gcal'] }, deps({ interactive: () => true, confirmReplace }));
    expect(saved).toEqual([]);
    expect(confirmReplace).toHaveBeenCalledWith(['gmail/me@x.com']);
    expect(await loadVault()).toEqual(before);
  });
});

describe('addGoogleProfiles: choosing in a terminal', () => {
  test('the prompt offers every service and its answer is used', async () => {
    const chooseServices = mock(async (all: string[]) => all.filter((s) => s === 'gtasks'));
    const saved = await addGoogleProfiles({ profile: 'w' }, deps({ interactive: () => true, chooseServices }));
    expect(chooseServices.mock.calls[0]![0]).toEqual(GOOGLE_SUITE.map((e) => e.service));
    expect(saved).toEqual(['gtasks/w']);
  });
});
