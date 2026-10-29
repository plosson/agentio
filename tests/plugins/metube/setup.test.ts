import { afterEach, expect, test } from 'bun:test';
import { fakeSetupContext } from '../../helpers/setup-context';
import { metubeProfileAdd } from '../../../src/plugins/metube/commands';
import { CliError } from '../../../src/utils/errors';
import { FakeMetube } from './fake-metube';

let server: FakeMetube;
afterEach(() => server?.stop());

test('setup stores URL and basic auth after checking them, asking for the password as a secret', async () => {
  server = new FakeMetube({ auth: { username: 'me', password: 'pw' } });
  const context = fakeSetupContext({ Password: 'pw' });
  const result = await metubeProfileAdd({ url: `${server.url}/`, username: 'me' }, context);
  expect(result.credentials).toEqual({ url: server.url, username: 'me', password: 'pw' });
  expect(context.asked.map((s) => [s.label, s.kind])).toEqual([['Password', 'secret']]);
  expect(result.info).not.toContain('pw');
});

test('setup without a username stores no credentials', async () => {
  server = new FakeMetube();
  const result = await metubeProfileAdd({ url: server.url, username: '' }, fakeSetupContext({}));
  expect(result.credentials).toEqual({ url: server.url });
});

test('setup refuses wrong credentials and a password without a username', async () => {
  server = new FakeMetube({ auth: { username: 'me', password: 'pw' } });
  await expect(metubeProfileAdd({ url: server.url, username: 'me', password: 'bad' }, fakeSetupContext({}))).rejects.toBeInstanceOf(CliError);
  await expect(metubeProfileAdd({ url: server.url, username: '', password: 'pw' }, fakeSetupContext({}))).rejects.toThrow('--password needs --username');
});
