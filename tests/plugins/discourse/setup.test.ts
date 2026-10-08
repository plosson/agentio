import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { fakeSetupContext } from '../../helpers/setup-context';
import { discourseProfileAdd } from '../../../src/plugins/discourse/commands';
import { FakeDiscourse, KEY, USER } from './fake-discourse';

withTempVault('agentio-discourse-setup-', () => ({ config: { profiles: {} } as never }));

describe('discourseProfileAdd', () => {
  let fake: FakeDiscourse;
  let logged: string[];
  beforeEach(() => { fake = new FakeDiscourse(); logged = []; });
  afterEach(() => fake.stop());

  const context = (answers: Record<string, string>) => ({ ...fakeSetupContext(answers), log: (m: string) => { logged.push(m); } });

  test('a URL that is not http(s) is refused before any request', async () => {
    await expect(discourseProfileAdd({}, context({ 'Forum URL': 'ftp://x', 'API key': KEY, Username: USER }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fake.log).toEqual([]);
  });

  test('a missing answer stops setup; nothing is requested', async () => {
    await expect(discourseProfileAdd({}, context({ 'Forum URL': fake.url, 'API key': KEY }))).rejects.toThrow('unexpected question: Username');
    expect(fake.log).toEqual([]);
  });

  test('a blank username is refused before any request', async () => {
    await expect(discourseProfileAdd({}, context({ 'Forum URL': fake.url, 'API key': KEY, Username: '  ' }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fake.log).toEqual([]);
  });

  test('a wrong key gives AUTH_FAILED with the plain message, and the key is never in it', async () => {
    const secret = 'SECRET-BAD-KEY';
    const err = await discourseProfileAdd({}, context({ 'Forum URL': fake.url, 'API key': secret, Username: USER })).catch((e) => e);
    expect(err).toMatchObject({ code: 'AUTH_FAILED', message: expect.stringMatching(/^Invalid API key or username/) });
    expect(`${err.message} ${err.suggestion ?? ''} ${logged.join(' ')}`).not.toContain(secret);
  });

  test('an unreachable forum gives NETWORK_ERROR', async () => {
    const url = fake.url;
    fake.stop();
    await expect(discourseProfileAdd({}, context({ 'Forum URL': url, 'API key': KEY, Username: USER })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    fake = new FakeDiscourse();
  });

  test('asks url, key, username in order; the steps are logged before the key, with the checked URL', async () => {
    const ctx = context({ 'Forum URL': `${fake.url}/`, 'API key': ` ${KEY} `, Username: ` ${USER} ` });
    const asked: string[] = [];
    const ask = ctx.ask;
    ctx.ask = async (spec) => { asked.push(spec.label); if (spec.label === 'API key') expect(logged.join('\n')).toContain(`${fake.url}/admin/api/keys`); return ask(spec); };
    const result = await discourseProfileAdd({}, ctx);
    expect(asked).toEqual(['Forum URL', 'API key', 'Username']);
    expect(result.credentials).toEqual({ baseUrl: fake.url, apiKey: KEY, username: USER });
    expect(result.suggestedProfileName).toBe(USER);
  });
});
