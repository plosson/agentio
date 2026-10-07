import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorCode } from '../../../src/utils/errors';
import { JevClient, JEV_API_URL } from '../../../src/plugins/jev/client';
import type { JevNoulAnswer } from '../../../src/plugins/jev/types';
import { caught, FakeJev, KEY } from './fake-api';

let api: FakeJev;
const client = (model?: string) => new JevClient({ apiKey: KEY, model });
const NOUL = { type: 'noul', instructions: 'Is it urgent?' } as const;
const ok = (answer: unknown) => ({ status: 200, body: { model: 'jev-1.13.0', answers: { answer }, usage: { input_tokens: 12, output_tokens: 0 } } });

beforeEach(() => { api = new FakeJev(); });
afterEach(() => api.restore());

describe('ask', () => {
  test('posts one question under the id "answer", with the key as a Bearer token', async () => {
    api.answer(ok({ type: 'noul', noul: 0.97 }));
    const result = await client().ask<JevNoulAnswer>('Please refund me', NOUL);
    const [req] = api.log;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(JEV_API_URL);
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toEqual({ model: 'jev-latest', state: 'Please refund me', questions: { answer: NOUL } });
    expect(result).toEqual({ model: 'jev-1.13.0', answer: { type: 'noul', noul: 0.97 }, usage: { input_tokens: 12, output_tokens: 0 } });
  });

  test('the model given wins over the profile\'s, which wins over jev-latest', async () => {
    api.answer(ok({ type: 'noul', noul: 1 })).answer(ok({ type: 'noul', noul: 1 }));
    await client('jev-preview').ask('x', NOUL);
    await client('jev-preview').ask('x', NOUL, 'jev-1.13.0');
    expect(api.log.map((r) => (r.body as { model: string }).model)).toEqual(['jev-preview', 'jev-1.13.0']);
  });

  test('a JSON state is sent as JSON, not as a string', async () => {
    api.answer(ok({ type: 'noul', noul: 0 }));
    await client().ask({ subject: 'hi' }, NOUL);
    expect((api.log[0].body as { state: unknown }).state).toEqual({ subject: 'hi' });
  });

  test('each status maps to its error', async () => {
    const cases: Array<[number, ErrorCode]> = [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [422, 'INVALID_PARAMS'], [400, 'INVALID_PARAMS'], [429, 'RATE_LIMITED'], [529, 'API_ERROR'], [500, 'API_ERROR']];
    for (const [status, code] of cases) {
      api.answer({ status, body: { error: { message: 'nope' } } });
      expect((await caught(client().ask('x', NOUL))).code).toBe(code);
    }
  });

  test('a validation error carries Jev\'s reason, whatever its shape', async () => {
    api.answer({ status: 422, body: { detail: [{ msg: 'criteria must have at least 2 levels' }] } });
    expect((await caught(client().ask('x', NOUL))).message).toContain('at least 2 levels');
    api.answer({ status: 422, body: { message: 'state too long' } });
    expect((await caught(client().ask('x', NOUL))).message).toContain('state too long');
  });

  test('the key never appears in an error, even when the server echoes it', async () => {
    api.answer({ status: 500, body: { error: `bad key ${KEY}` } });
    const err = await caught(client().ask('x', NOUL));
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[api key]');
  });

  test('a success without the answer, or with an answer of another type, is an error', async () => {
    api.answer({ status: 200, body: { model: 'm', answers: {} } });
    expect((await caught(client().ask('x', NOUL))).code).toBe('API_ERROR');
    api.answer(ok({ type: 'choice', choice: 'a', confidence: 1, probabilities: {} }));
    expect((await caught(client().ask('x', NOUL))).code).toBe('API_ERROR');
    api.answer({ status: 200, raw: '<html>ok</html>' });
    expect((await caught(client().ask('x', NOUL))).code).toBe('API_ERROR');
  });

  test('no network is NETWORK_ERROR', async () => {
    api.answer('network-error');
    expect((await caught(client().ask('x', NOUL))).code).toBe('NETWORK_ERROR');
  });
});

test('validate reports a refused key instead of throwing', async () => {
  api.answer({ status: 401, body: { error: 'invalid key' } });
  expect((await client().validate()).valid).toBe(false);
});
