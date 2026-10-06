import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { fakeSetupContext } from '../../helpers/setup-context';
import { discourseProfileAdd } from '../../../src/plugins/discourse/commands';
import { DISCOURSE_SETUP_NEEDS } from '../../../src/plugins/discourse/setup-needs';
import { FakeDiscourse, KEY, USER } from './fake-discourse';

withTempVault('agentio-discourse-setup-', () => ({ config: { profiles: {} } as never }));

describe('discourseProfileAdd', () => {
  let fake: FakeDiscourse;
  let logged: string[];
  beforeEach(() => { fake = new FakeDiscourse(); logged = []; });
  afterEach(() => fake.stop());

  const context = (answers: Record<string, string>) => ({ ...fakeSetupContext(answers), log: (m: string) => { logged.push(m); } });

  test('a URL that is not http(s) is refused before any request', async () => {
    await expect(discourseProfileAdd({}, context({ url: 'ftp://x', apiKey: KEY, username: USER }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fake.log).toEqual([]);
  });

  test('a missing answer stops setup; nothing is requested', async () => {
    await expect(discourseProfileAdd({}, context({ url: fake.url, apiKey: KEY }))).rejects.toThrow('unexpected question: username');
    expect(fake.log).toEqual([]);
  });

  test('a blank username is refused before any request', async () => {
    await expect(discourseProfileAdd({}, context({ url: fake.url, apiKey: KEY, username: '  ' }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fake.log).toEqual([]);
  });

  test('a wrong key gives AUTH_FAILED with the plain message', async () => {
    await expect(discourseProfileAdd({}, context({ url: fake.url, apiKey: 'nope', username: USER })))
      .rejects.toMatchObject({ code: 'AUTH_FAILED', message: expect.stringMatching(/^Invalid API key or username/) });
  });

  test('an unreachable forum gives NETWORK_ERROR', async () => {
    const url = fake.url;
    fake.stop();
    await expect(discourseProfileAdd({}, context({ url, apiKey: KEY, username: USER })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    fake = new FakeDiscourse();
  });

  test('asks url, key, username in order; the steps are logged before the key, with the checked URL', async () => {
    const ctx = context({ url: `${fake.url}/`, apiKey: ` ${KEY} `, username: ` ${USER} ` });
    const asked: string[] = [];
    const ask = ctx.ask;
    ctx.ask = async (spec) => { asked.push(spec.id); if (spec.id === 'apiKey') expect(logged.join('\n')).toContain(`${fake.url}/admin/api/keys`); return ask(spec); };
    const result = await discourseProfileAdd({}, ctx);
    expect(asked).toEqual(['url', 'apiKey', 'username']);
    expect(result.credentials).toEqual({ baseUrl: fake.url, apiKey: KEY, username: USER });
    expect(result.suggestedProfileName).toBe(USER);
  });

  test('the needs are the three inputs, no sign-in', () => {
    expect(DISCOURSE_SETUP_NEEDS.inputs.map((i) => i.id)).toEqual(['url', 'apiKey', 'username']);
    expect(DISCOURSE_SETUP_NEEDS.auth).toBe('none');
  });
});
