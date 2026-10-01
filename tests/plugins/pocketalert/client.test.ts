import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseLevel, PocketAlertClient, POCKETALERT_API_URL } from '../../../src/plugins/pocketalert/client';
import { caught, FakePocketAlert, KEY } from './fake-api';

let api: FakePocketAlert;
const client = () => new PocketAlertClient({ apiKey: KEY });

beforeEach(() => { api = new FakePocketAlert(); });
afterEach(() => api.restore());

const SENT = { tid: 'm1', title: 'T', message: 'M', created_at: '01.10.2026 13:03:43' };

describe('send', () => {
  test('posts only the given fields, with the key in the Token header', async () => {
    api.answer({ status: 201, body: SENT });
    await client().send({ title: 'T', message: 'M', application_id: undefined, device_id: 'd1', level: -2 });
    const [req] = api.log;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${POCKETALERT_API_URL}/messages`);
    expect(req.headers.token).toBe(KEY);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toEqual({ title: 'T', message: 'M', device_id: 'd1', level: -2 });
  });

  test('a blank title or message is refused before any request', async () => {
    expect((await caught(client().send({ title: '  ', message: 'M' }))).code).toBe('INVALID_PARAMS');
    expect((await caught(client().send({ title: 'T', message: '\n' }))).code).toBe('INVALID_PARAMS');
    expect(api.log).toHaveLength(0);
  });

  test('a refused key is AUTH_FAILED, whatever the body says', async () => {
    api.answer({ status: 401, body: { error: 'Invalid token' } });
    expect((await caught(client().send({ title: 'T', message: 'M' }))).code).toBe('AUTH_FAILED');
    api.answer({ status: 401, raw: '<html>proxy</html>' });
    expect((await caught(client().send({ title: 'T', message: 'M' }))).code).toBe('AUTH_FAILED');
  });

  test('a validation error carries the server\'s reason', async () => {
    api.answer({ status: 400, body: { error: 'invalid level: "bogus"' } });
    const err = await caught(client().send({ title: 'T', message: 'M', level: 'bogus' }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('invalid level');
  });

  test('the daily limit is QUOTA_EXCEEDED, not a generic API error', async () => {
    api.answer({ status: 429, body: { error: 'Daily limit reached' } });
    expect((await caught(client().send({ title: 'T', message: 'M' }))).code).toBe('QUOTA_EXCEEDED');
  });

  test('an unknown device or application, which the server answers with 500, is NOT_FOUND', async () => {
    api.answer({ status: 500, body: { error: 'Device not found' } });
    expect((await caught(client().send({ title: 'T', message: 'M', device_id: 'x' }))).code).toBe('NOT_FOUND');
    api.answer({ status: 500, body: { error: 'record not found' } });
    expect((await caught(client().send({ title: 'T', message: 'M', application_id: 'x' }))).code).toBe('NOT_FOUND');
  });

  test('any other server failure is API_ERROR, and never shows the key', async () => {
    api.answer({ status: 500, body: { error: `token ${KEY} broke something` } });
    const err = await caught(client().send({ title: 'T', message: 'M' }));
    expect(err.code).toBe('API_ERROR');
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[api key]');

    api.answer({ status: 502, raw: 'Bad Gateway' });
    expect((await caught(client().send({ title: 'T', message: 'M' }))).message).toContain('502');
  });

  test('a success that is not JSON is an error, not an empty result', async () => {
    api.answer({ status: 201, raw: '<html>ok</html>' });
    expect((await caught(client().send({ title: 'T', message: 'M' }))).code).toBe('API_ERROR');
  });

  test('no network is NETWORK_ERROR', async () => {
    api.answer('network-error');
    expect((await caught(client().send({ title: 'T', message: 'M' }))).code).toBe('NETWORK_ERROR');
  });
});

describe('applications', () => {
  test('anything but a list reads as no applications', async () => {
    api.answer({ status: 200, body: { unexpected: true } });
    expect(await client().applications()).toEqual([]);
  });

  test('validate reports a refused key instead of throwing', async () => {
    api.answer({ status: 401, body: { error: 'Invalid token' } });
    const result = await client().validate();
    expect(result.valid).toBe(false);
  });
});

describe('parseLevel', () => {
  test('whole numbers from -2 to 2 become numbers', () => {
    expect(parseLevel('-2')).toBe(-2);
    expect(parseLevel(' 2 ')).toBe(2);
    expect(parseLevel('+1')).toBe(1);
    expect(parseLevel('0')).toBe(0);
  });

  test('numbers out of range are refused', () => {
    for (const bad of ['3', '-3', '99999999999999999999']) {
      expect(() => parseLevel(bad)).toThrow('-2 to 2');
    }
  });

  test('names pass through for the server to judge; blanks do not', () => {
    expect(parseLevel('critical')).toBe('critical');
    expect(parseLevel('1.5')).toBe('1.5');
    expect(() => parseLevel('   ')).toThrow('cannot be empty');
  });
});
