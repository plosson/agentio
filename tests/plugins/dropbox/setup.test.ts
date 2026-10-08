import { expect, test } from 'bun:test';
import { fakeSetupContext } from '../../helpers/setup-context';
import { dropboxProfileAdd } from '../../../src/plugins/dropbox/commands';
import { APP_KEY_INPUT, CODE_INPUT } from '../../../src/plugins/dropbox/setup-questions';

test('the authorise address carries the app key and a PKCE challenge; then the code is asked as a secret', async () => {
  const opened: string[] = [];
  const context = fakeSetupContext({ 'App key': ' my-app-key ' }, opened);
  // No code answer: setup stops at the code question, so nothing reaches Dropbox's token endpoint.
  await expect(dropboxProfileAdd({}, context)).rejects.toThrow(`unexpected question: ${CODE_INPUT.label}`);
  expect(opened).toHaveLength(1);
  const url = new URL(opened[0]);
  expect(url.searchParams.get('client_id')).toBe('my-app-key');
  expect(url.searchParams.get('code_challenge')).toBeTruthy();
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(context.asked).toEqual([APP_KEY_INPUT, CODE_INPUT]);
  expect(CODE_INPUT.kind).toBe('secret');
});

test('--app-key skips the app key question', async () => {
  const opened: string[] = [];
  const context = fakeSetupContext({}, opened);
  await expect(dropboxProfileAdd({ appKey: 'flag-key' }, context)).rejects.toThrow(`unexpected question: ${CODE_INPUT.label}`);
  expect(new URL(opened[0]).searchParams.get('client_id')).toBe('flag-key');
  expect(context.asked).toEqual([CODE_INPUT]);
});

test('an empty app key is refused before anything is opened', async () => {
  for (const [options, answers] of [[{ appKey: '  ' }, {}], [{}, { 'App key': '  ' }]] as const) {
    const opened: string[] = [];
    const context = fakeSetupContext(answers, opened);
    await expect(dropboxProfileAdd(options, context)).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'App key is required' });
    expect(opened).toEqual([]);
    expect(context.asked).not.toContain(CODE_INPUT);
  }
});
