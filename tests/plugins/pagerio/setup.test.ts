import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { fakeSetupContext } from '../../helpers/setup-context';
import { pagerioProfileAdd } from '../../../src/plugins/pagerio/commands';
import { addProfileWithSetup } from '../../../src/plugins/profile-host';
import { getCredentials } from '../../../src/auth/token-store';
import type { PagerioCredentials } from '../../../src/plugins/pagerio/types';
import { caught, FakePager, PAGER_URL, serverError, TOKEN } from './fake-pager';

// The installed agentio's folder, as it is before any test runs.
const REAL_CONFIG = join(process.env.HOME || homedir(), '.config', 'agentio');
function snapshot(dir: string): string {
  if (!existsSync(dir)) return 'absent';
  return readdirSync(dir).sort().map((name) => {
    const s = statSync(join(dir, name));
    return `${name}:${s.size}:${s.mtimeMs}`;
  }).join('|');
}
const REAL_BEFORE = snapshot(REAL_CONFIG);

withTempVault('agentio-pagerio-setup-', () => ({ config: { profiles: {} } as never }));

let api: FakePager;
const originalLog = console.log;
const originalError = console.error;

// No answers: any question fails, so a value given as an option is never asked for.
const noPrompt = () => fakeSetupContext({});
const KNOWN = { status: 400, body: serverError('invalid_input', 'Body is not valid JSON.') };
const UNKNOWN = { status: 404, body: serverError('not_found', 'Unknown pager URL.') };

beforeEach(() => {
  api = new FakePager();
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  api.restore();
  console.log = originalLog;
  console.error = originalError;
});

afterAll(() => {
  expect(snapshot(REAL_CONFIG)).toBe(REAL_BEFORE);
});

test('setup checks the URL with one request that pages no one, and stores it trimmed', async () => {
  api.answer(KNOWN);
  const result = await pagerioProfileAdd({ url: ` ${PAGER_URL}\n` }, noPrompt());
  expect(result.credentials).toEqual({ url: PAGER_URL });
  expect(result.info).toContain('pagerio.chuut.com');
  expect(api.log.map((r) => `${r.method} ${r.url} ${r.body}`)).toEqual([`POST ${PAGER_URL} {`]);
});

test('the URL is asked for when --url is absent, as a secret', async () => {
  api.answer(KNOWN);
  const context = fakeSetupContext({ 'Pager URL': PAGER_URL });
  const result = await pagerioProfileAdd({}, context);
  expect(context.asked.map((s) => s.label)).toEqual(['Pager URL']);
  expect(context.asked[0].kind).toBe('secret');
  expect(result.credentials.url).toBe(PAGER_URL);
  expect(result.suggestedProfileName).toBe('default');
  expect(result.info).not.toContain(TOKEN);
});

test('a blank or malformed URL is refused before any request', async () => {
  for (const url of ['   ', 'not a url', 'https://pagerio.chuut.com/p/short', `${PAGER_URL}?x=1`, `${PAGER_URL}#frag`]) {
    const err = await caught(pagerioProfileAdd({ url }, noPrompt()));
    expect(err.code).toBe('INVALID_PARAMS');
    // The URL is the secret: a refusal never repeats it.
    expect(`${err.message} ${err.suggestion ?? ''}`).not.toContain(TOKEN);
  }
  expect((await caught(pagerioProfileAdd({}, fakeSetupContext({ 'Pager URL': '' })))).code).toBe('INVALID_PARAMS');
  expect(api.log).toHaveLength(0);
});

test('an unknown URL saves no profile, and the URL is never in the error', async () => {
  api.answer(UNKNOWN);
  const err = await caught(addProfileWithSetup('pagerio', (o) => pagerioProfileAdd(o, noPrompt()), { url: PAGER_URL } as never));
  expect(err.code).toBe('NOT_FOUND');
  expect(`${err.message} ${err.suggestion ?? ''}`).not.toContain(TOKEN);
  expect(await getCredentials<PagerioCredentials>('pagerio', 'default')).toBeNull();
});

test('a working URL is saved under the chosen name', async () => {
  api.answer(KNOWN);
  await addProfileWithSetup('pagerio', (o) => pagerioProfileAdd(o, noPrompt()), { url: PAGER_URL, profile: 'me' } as never);
  expect(await getCredentials<PagerioCredentials>('pagerio', 'me')).toEqual({ url: PAGER_URL });
});
