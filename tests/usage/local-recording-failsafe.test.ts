import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';

// Module mocks last for the whole process: keep the real exports and put them
// back in afterAll, so files that import cli.ts later still get a version.
const real = { ...(await import('../../src/utils/version')) };
mock.module('../../src/utils/version', () => ({
  agentioVersion: () => { throw new Error('package.json unreadable'); },
}));

afterAll(() => { mock.module('../../src/utils/version', () => real); });

const { getCredentials } = await import('../../src/auth/token-store');
const { closeUsageStore } = await import('../../src/usage/store');
const { resetUsageContext, setUsageCommand } = await import('../../src/usage/context');

withTempVault('agentio-usage-failsafe-', () => ({
  config: { profiles: { gmail: [{ name: 'work' }] } },
  credentials: { gmail: { work: { access_token: 'at' } } },
}));

beforeEach(() => resetUsageContext());
afterEach(() => { resetUsageContext(); closeUsageStore(); });

test('an event that cannot be built does not change the credentials returned', async () => {
  setUsageCommand(['gmail', 'list']);
  expect(await getCredentials<{ access_token: string }>('gmail', 'work')).toEqual({ access_token: 'at' });
});
