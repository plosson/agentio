import { afterEach, beforeEach, expect, test } from 'bun:test';
import { fakeSetupContext } from '../../helpers/setup-context';
import { FakeFetch } from '../../helpers/fake-fetch';
import { jevProfileAdd } from '../../../src/plugins/jev/commands';
import { CliError } from '../../../src/utils/errors';

const SECRET = 'SECRET-KEY-123';

let api: FakeFetch;
beforeEach(() => { api = new FakeFetch(); });
afterEach(() => api.restore());

const answered = () => api.answer({ status: 200, body: { model: 'jev-1.13.0', answers: { answer: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 0 } } });

test('a blank or missing key is refused before any request', async () => {
  for (const [options, answers] of [[{ apiKey: '   ' }, {}], [{}, { 'API key': '' }]] as const) {
    const err = await jevProfileAdd(options, fakeSetupContext(answers)).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect([err.code, err.message]).toEqual(['INVALID_PARAMS', 'API key is required']);
  }
  expect(api.log).toEqual([]);
});

test('a wrong key: AUTH_FAILED, and the key is never in the error', async () => {
  api.answer({ status: 401, body: { error: 'invalid key' } });
  const err = await jevProfileAdd({ apiKey: SECRET, model: 'jev-preview' }, fakeSetupContext({})).catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect(err.code).toBe('AUTH_FAILED');
  expect(`${err.message} ${err.suggestion ?? ''}`).not.toContain(SECRET);
  expect(api.log).toHaveLength(1);
});

test('only the key given: the optional model is asked, a blank answer saves no model', async () => {
  answered();
  const context = fakeSetupContext({ 'Default model': '' });
  const result = await jevProfileAdd({ apiKey: ` ${SECRET} ` }, context);
  expect(context.asked.map((s) => s.label)).toEqual(['Default model']);
  expect(result.credentials).toEqual({ apiKey: SECRET });
  expect(result.suggestedProfileName).toBe('default');
  expect(result.info).not.toContain(SECRET);
  expect(api.log[0].headers.authorization).toBe(`Bearer ${SECRET}`);
});

test('key and model given: nothing asked, the key is checked with that model', async () => {
  answered();
  const context = fakeSetupContext({});
  const result = await jevProfileAdd({ apiKey: SECRET, model: 'jev-preview' }, context);
  expect(context.asked).toEqual([]);
  expect(result.credentials).toEqual({ apiKey: SECRET, model: 'jev-preview' });
  expect((api.log[0].body as { model: string }).model).toBe('jev-preview');
});
