import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PagerioClient, parsePagerUrl } from '../../../src/plugins/pagerio/client';
import { pageInput } from '../../../src/plugins/pagerio/commands';
import { caught, FakePager, PAGER_URL, serverError, TOKEN } from './fake-pager';

let api: FakePager;
const client = () => new PagerioClient({ url: PAGER_URL });

beforeEach(() => { api = new FakePager(); });
afterEach(() => api.restore());

const ACCEPTED = { id: 'pg_1', status: 'accepted', view_url: 'https://pagerio.chuut.com/v/XyZ0123456789abc' };

describe('parsePagerUrl', () => {
  test('accepts the URL as the dashboard copies it, trimmed, in one canonical form', () => {
    expect(parsePagerUrl(` ${PAGER_URL}\n`)).toBe(PAGER_URL);
    expect(parsePagerUrl(`HTTPS://PAGERIO.CHUUT.COM/p/${TOKEN}`)).toBe(PAGER_URL);
    expect(parsePagerUrl(`http://localhost:3000/p/${TOKEN}`)).toBe(`http://localhost:3000/p/${TOKEN}`);
  });

  test('refuses anything that is not exactly a pager URL', () => {
    for (const bad of [
      '',
      '   ',
      TOKEN,
      'pagerio.chuut.com/p/' + TOKEN,
      `http://pagerio.chuut.com/p/${TOKEN}`, // plain http off localhost would send the secret in clear
      `https://pagerio.chuut.com/v/${TOKEN}`, // a page view link, not the pager
      `https://pagerio.chuut.com/p/${TOKEN}/`,
      `https://pagerio.chuut.com/p/${TOKEN}x`,
      `https://pagerio.chuut.com/p/${TOKEN.slice(1)}`,
      'https://pagerio.chuut.com/p/5rKcQCQoWL-RIIMX0Y5xVssrydI-a3t2mTinR8Z4dno', // the old 43-character format
      `https://pagerio.chuut.com/p/${TOKEN}?x=1`,
      `https://pagerio.chuut.com/p/${TOKEN}#top`,
      `https://user:pw@pagerio.chuut.com/p/${TOKEN}`,
      `ftp://pagerio.chuut.com/p/${TOKEN}`,
      `javascript:alert(1)//p/${TOKEN}`,
    ]) {
      expect(() => parsePagerUrl(bad)).toThrow('not a pager URL');
    }
  });
});

describe('check', () => {
  test('a known URL answers 400 to invalid JSON, and nothing is paged', async () => {
    api.answer({ status: 400, body: serverError('invalid_input', 'Body is not valid JSON.') });
    await client().check();
    const [req] = api.log;
    expect([req.method, req.url, req.headers['content-type'], req.body]).toEqual(['POST', PAGER_URL, 'application/json', '{']);
  });

  test('an unknown URL is NOT_FOUND and says how to get the right one', async () => {
    api.answer({ status: 404, body: serverError('not_found', 'Unknown pager URL.') });
    const err = await caught(client().check());
    expect(err.code).toBe('NOT_FOUND');
    expect(err.suggestion).toContain('Copy button');
  });

  test('a server that accepts the probe as a page is not mistaken for a working check', async () => {
    api.answer({ status: 202, body: ACCEPTED });
    expect((await caught(client().check())).code).toBe('API_ERROR');
  });

  test('validate reports an unknown URL instead of throwing', async () => {
    api.answer({ status: 404, body: serverError('not_found', 'Unknown pager URL.') });
    expect((await client().validate()).valid).toBe(false);
  });
});

describe('send', () => {
  test('posts only the given fields as JSON, with the idempotency key as a header', async () => {
    api.answer({ status: 202, body: ACCEPTED });
    const page = await client().send({ title: 'T', message: 'M' }, 'deploy-42');
    expect(page).toEqual(ACCEPTED);
    const [req] = api.log;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(PAGER_URL);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['idempotency-key']).toBe('deploy-42');
    expect(JSON.parse(req.body!)).toEqual({ title: 'T', message: 'M' });
  });

  test('without a key there is no Idempotency-Key header', async () => {
    api.answer({ status: 202, body: ACCEPTED });
    await client().send({});
    expect(api.log[0].headers['idempotency-key']).toBeUndefined();
    expect(api.log[0].body).toBe('{}');
  });

  test('a refused field carries the server\'s reason', async () => {
    api.answer({ status: 400, body: serverError('invalid_input', 'title must be at most 100 characters.') });
    const err = await caught(client().send({ title: 'x'.repeat(101) }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('title must be at most 100 characters');
  });

  test('a body over the limit is INVALID_PARAMS, not a server failure', async () => {
    api.answer({ status: 413, body: serverError('payload_too_large', 'Request body must be at most 16384 bytes.') });
    expect((await caught(client().send({ details: 'x' }))).code).toBe('INVALID_PARAMS');
  });

  test('too many pages is RATE_LIMITED', async () => {
    api.answer({ status: 429, body: serverError('rate_limited', 'Too many pages. Try again later.') });
    expect((await caught(client().send({}))).code).toBe('RATE_LIMITED');
  });

  test('no message, error or suggestion ever shows the pager URL or its token', async () => {
    const answers = [
      { status: 500, body: serverError('internal', `failed for ${PAGER_URL}`) },
      { status: 400, body: serverError('invalid_input', `bad token ${TOKEN}`) },
      { status: 404, body: serverError('not_found', `no ${TOKEN}`) },
    ];
    for (const answer of answers) {
      api.answer(answer);
      const err = await caught(client().send({}));
      expect(`${err.message} ${err.suggestion ?? ''}`).not.toContain(TOKEN);
    }
    api.answer('network-error');
    const err = await caught(client().send({}));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toContain('pagerio.chuut.com');
    expect(err.message).not.toContain(TOKEN);
  });

  test('a success that can\'t be read is an error, not a silent success', async () => {
    for (const answer of [{ status: 202, raw: '<html>ok</html>' }, { status: 202, body: { status: 'accepted' } }, { status: 202, raw: '' }]) {
      api.answer(answer);
      expect((await caught(client().send({}))).code).toBe('API_ERROR');
    }
  });

  test('a proxy\'s error page reports the status', async () => {
    api.answer({ status: 502, raw: 'Bad Gateway' });
    const err = await caught(client().send({}));
    expect(err.code).toBe('API_ERROR');
    expect(err.message).toContain('502');
  });
});

describe('pageInput', () => {
  test('keeps only the given fields, trimmed, and maps --link to url', () => {
    expect(pageInput(' Done ', { title: ' Build ', link: 'https://e.test', group: 'ci' })).toEqual({ message: 'Done', title: 'Build', url: 'https://e.test', group: 'ci' });
    expect(pageInput(undefined, {})).toEqual({});
  });

  test('a blank value is refused rather than sent as empty', () => {
    expect(() => pageInput('  ', {})).toThrow('cannot be empty');
    for (const option of ['title', 'details', 'link', 'group'] as const) {
      expect(() => pageInput('M', { [option]: '\n' })).toThrow(`--${option} cannot be empty`);
    }
  });
});
