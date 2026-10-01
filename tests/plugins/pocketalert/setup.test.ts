import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { pocketAlertProfileAdd, type PocketAlertSetupDeps } from '../../../src/plugins/pocketalert/commands';
import { addProfileWithSetup } from '../../../src/plugins/profile-host';
import { getCredentials } from '../../../src/auth/token-store';
import type { PocketAlertCredentials } from '../../../src/plugins/pocketalert/types';
import { caught, FakePocketAlert, KEY } from './fake-api';

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

withTempVault('agentio-pocketalert-setup-', () => ({ config: { profiles: {} } as never }));

let api: FakePocketAlert;
const originalLog = console.log;
const originalError = console.error;

const noPrompt: PocketAlertSetupDeps = {
  prompt: async () => { throw new Error('prompt must not be used when --api-key is given'); },
};

beforeEach(() => {
  api = new FakePocketAlert();
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

test('setup checks the key without sending a message, and trims it', async () => {
  api.answer({ status: 200, body: [{ tid: 'a1', name: 'agentio' }] });
  const result = await pocketAlertProfileAdd({ apiKey: ` ${KEY}\n` }, noPrompt);
  expect(result.credentials).toEqual({ apiKey: KEY });
  expect(result.info).toContain('1 application');
  expect(api.log.map((r) => `${r.method} ${r.url}`)).toEqual(['GET https://api.pocketalert.app/v1/applications']);
});

test('the key is asked for when --api-key is absent', async () => {
  api.answer({ status: 200, body: [] });
  const questions: string[] = [];
  const result = await pocketAlertProfileAdd({}, { prompt: async (q) => { questions.push(q); return KEY; } });
  expect(questions).toHaveLength(1);
  expect(result.credentials.apiKey).toBe(KEY);
});

test('a blank key is refused before any request', async () => {
  expect((await caught(pocketAlertProfileAdd({ apiKey: '   ' }, noPrompt))).code).toBe('INVALID_PARAMS');
  expect((await caught(pocketAlertProfileAdd({}, { prompt: async () => '' }))).code).toBe('INVALID_PARAMS');
  expect(api.log).toHaveLength(0);
});

test('a refused key saves no profile', async () => {
  api.answer({ status: 401, body: { error: 'Invalid token' } });
  const err = await caught(addProfileWithSetup('pocketalert', (o) => pocketAlertProfileAdd(o, noPrompt), { apiKey: 'nope' } as never));
  expect(err.code).toBe('AUTH_FAILED');
  expect(await getCredentials<PocketAlertCredentials>('pocketalert', 'default')).toBeNull();
});

test('a working key is saved under the chosen name', async () => {
  api.answer({ status: 200, body: [] });
  await addProfileWithSetup('pocketalert', (o) => pocketAlertProfileAdd(o, noPrompt), { apiKey: KEY, profile: 'phone' } as never);
  expect(await getCredentials<PocketAlertCredentials>('pocketalert', 'phone')).toEqual({ apiKey: KEY });
});
