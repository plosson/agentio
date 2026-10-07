import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorCode } from '../../../src/utils/errors';
import { JevClient, JEV_API_URL } from '../../../src/plugins/jev/client';
import type { JevNoulAnswer, JevQuestion } from '../../../src/plugins/jev/types';
import { caught, FakeFetch } from '../../helpers/fake-fetch';
import { KEY } from './key';

let api: FakeFetch;
const client = (model?: string) => new JevClient({ apiKey: KEY, model });
const NOUL = { type: 'noul', instructions: 'Is it urgent?' } as const;
const ok = (answer: unknown) => ({ status: 200, body: { model: 'jev-1.13.0', answers: { answer }, usage: { input_tokens: 12, output_tokens: 0 } } });

beforeEach(() => { api = new FakeFetch(); });
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

  test('an answer whose fields are missing, not numbers, or not finite is an error, never a value', async () => {
    const choice: JevQuestion = { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } };
    const score: JevQuestion = { type: 'score', instructions: 'How?', criteria: ['low', 'high'] };
    const bad: Array<[JevQuestion, unknown]> = [
      [NOUL, { type: 'noul' }],
      [NOUL, { type: 'noul', noul: '0.9' }],
      [NOUL, { type: 'noul', noul: null }],
      [NOUL, { type: 'noul', noul: Infinity }],  // serialises to null
      [choice, { type: 'choice', choice: 'a' }],
      [choice, { type: 'choice', confidence: 0.9 }],
      [choice, { type: 'choice', choice: 7, confidence: 0.9 }],
      [choice, { type: 'choice', choice: 'a', confidence: '0.9' }],
      [score, { type: 'score', confidence: 0.5 }],
      [score, { type: 'score', score: 1.3 }],
      [score, { type: 'score', score: 'high', confidence: 0.5 }],
    ];
    for (const [question, answer] of bad) {
      api.answer(ok(answer));
      const err = await caught(client().ask('x', question));
      expect([JSON.stringify(answer), err.code, err.message]).toEqual([JSON.stringify(answer), 'API_ERROR', 'Jev answered without a usable answer']);
    }
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
