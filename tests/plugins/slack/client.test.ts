import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { checkUserToken, isUserId, SlackClient } from '../../../src/plugins/slack/client';
import { caught, FakeSlack, rawUser, TOKEN } from './fake-slack';

let fake: FakeSlack;
let slept: number[];
let client: SlackClient;

function tokenClient(token = TOKEN): SlackClient {
  return new SlackClient({ type: 'token', token }, { sleep: async (ms) => { slept.push(ms); } });
}

beforeEach(() => {
  fake = new FakeSlack();
  slept = [];
  client = tokenClient();
});

afterEach(() => fake.stop());

/** Everything a user could see of an error. */
const shown = (e: { message: string; suggestion?: string }) => `${e.message} ${e.suggestion ?? ''}`;

describe('checkUserToken', () => {
  test('a bot token is refused with a hint to use the user token', () => {
    expect(() => checkUserToken('xoxb-123-456-abc')).toThrow(/bot token/);
  });

  test('app-level, legacy and garbage tokens are refused', () => {
    for (const bad of ['xapp-1-A0-123', 'xoxa-2-123', 'xoxs-123', 'Bearer xoxp-123', 'xoxp-', 'xoxp-abc def', 'xoxp-abc\nX-Evil: 1', '']) {
      expect(() => checkUserToken(bad)).toThrow();
    }
  });

  test('surrounding whitespace from a paste is dropped', () => {
    expect(checkUserToken(`  ${TOKEN}\n`)).toBe(TOKEN);
  });
});

describe('isUserId', () => {
  test('U and W ids are ids; lowercase, emails and channel ids are not', () => {
    expect(isUserId('U0123ABC')).toBe(true);
    expect(isUserId('W0123ABC')).toBe(true);
    for (const no of ['u0123abc', 'C0123ABC', 'U', 'jane@example.com', 'U0123 ABC']) expect(isUserId(no)).toBe(false);
  });
});

describe('requests', () => {
  test('the token travels only in the Authorization header, never in the URL or body', async () => {
    await client.listUsers();
    for (const call of fake.log) {
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.url).not.toContain(TOKEN);
      expect(JSON.stringify(call.params)).not.toContain(TOKEN);
      expect(call.method).toBe('POST');
      expect(call.contentType).toBe('application/x-www-form-urlencoded');
    }
  });

  test('an email with + and & arrives intact, not split into extra parameters', async () => {
    fake.users.push(rawUser('U0009', { profile: { email: 'jane+slack&x=1@example.com' } }));
    const user = await client.getUser('jane+slack&x=1@example.com');
    expect(user.id).toBe('U0009');
    expect(fake.log.at(-1)!.params).toEqual({ email: 'jane+slack&x=1@example.com' });
  });

  test('a webhook profile never calls the Web API', async () => {
    const webhook = new SlackClient({ type: 'webhook', webhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    const err = await caught(webhook.listUsers());
    expect(err.code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('a token profile refuses to send instead of posting somewhere', async () => {
    const err = await caught(client.send({ text: 'hi' }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });
});

describe('errors', () => {
  test('a refused token is AUTH_FAILED and the token is never echoed', async () => {
    const bad = tokenClient('xoxp-9999-wrong-token');
    const err = await caught(bad.listUsers());
    expect(err.code).toBe('AUTH_FAILED');
    expect(shown(err)).not.toContain('xoxp-9999-wrong-token');
  });

  test('a missing scope is PERMISSION_DENIED and names the scope to add', async () => {
    fake.scopes.delete('users:read.email');
    const err = await caught(client.getUser('u0001@example.com'));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(shown(err)).toContain('users:read.email');
  });

  test('an unknown email is NOT_FOUND', async () => {
    expect((await caught(client.getUser('nobody@example.com'))).code).toBe('NOT_FOUND');
  });

  test('an unknown id is NOT_FOUND', async () => {
    expect((await caught(client.getUser('U9999999'))).code).toBe('NOT_FOUND');
  });

  test('blank input, a bare name and a lowercase id are refused before any request', async () => {
    for (const input of ['', '   ', 'jane', 'u0001', '@jane']) {
      expect((await caught(client.getUser(input))).code).toBe('INVALID_PARAMS');
    }
    expect(fake.log).toHaveLength(0);
  });

  test('an HTML error page is an API_ERROR, not a JSON crash', async () => {
    fake.queue.push({ status: 502, text: '<html>Bad gateway</html>' });
    const err = await caught(client.authTest());
    expect(err.code).toBe('API_ERROR');
    expect(err.message).toContain('502');
  });

  test('ok:false without an error code, and a JSON null body, are API_ERRORs', async () => {
    fake.queue.push({ status: 200, body: { ok: false } }, { status: 200, text: 'null' });
    expect((await caught(client.authTest())).code).toBe('API_ERROR');
    expect((await caught(client.authTest())).code).toBe('API_ERROR');
  });

  test('ok as the string "true" is not success', async () => {
    fake.queue.push({ status: 200, body: { ok: 'true', team: 'x' } });
    expect((await caught(client.authTest())).code).toBe('API_ERROR');
  });

  test('a network failure is NETWORK_ERROR and does not quote the underlying error', async () => {
    fake.queue.push({ throws: new Error(`connect failed with ${TOKEN}`) });
    const err = await caught(client.authTest());
    expect(err.code).toBe('NETWORK_ERROR');
    expect(shown(err)).not.toContain(TOKEN);
  });

  test('validate reports a bad token as invalid instead of throwing', async () => {
    const result = await tokenClient('xoxp-1-bad').validate();
    expect(result.valid).toBe(false);
  });
});

describe('rate limits', () => {
  test('a 429 is retried after Retry-After seconds, then succeeds', async () => {
    fake.queue.push({ status: 429, headers: { 'Retry-After': '3' } });
    expect((await client.authTest()).teamName).toBe('Example Co');
    expect(slept).toEqual([3000]);
    expect(fake.log).toHaveLength(2);
  });

  test('a huge Retry-After is capped, and a garbage one waits 1 second', async () => {
    fake.queue.push({ status: 429, headers: { 'Retry-After': '86400' } }, { status: 429, headers: { 'Retry-After': 'soon' } }, { status: 429 });
    await client.authTest();
    expect(slept).toEqual([60_000, 1000, 1000]);
  });

  test('after 3 retries it gives up with RATE_LIMITED instead of looping', async () => {
    for (let i = 0; i < 10; i++) fake.queue.push({ status: 429, headers: { 'Retry-After': '1' } });
    const err = await caught(client.authTest());
    expect(err.code).toBe('RATE_LIMITED');
    expect(fake.log).toHaveLength(4);
  });

  test('a 429 in the middle of paging resumes at the same cursor', async () => {
    fake.users = ['U1', 'U2', 'U3'].map((id) => rawUser(id));
    fake.pageSize = 1;
    // Page 1 is scripted so that the 429 lands on the request for page 2.
    fake.queue.push({ status: 200, text: JSON.stringify({ ok: true, members: [rawUser('U1')], response_metadata: { next_cursor: 'page-1' } }) });
    fake.queue.push({ status: 429, headers: { 'Retry-After': '1' } });
    const users = await client.listUsers();
    expect(users.map((u) => u.id)).toEqual(['U1', 'U2', 'U3']);
    expect(fake.log.map((c) => c.params.cursor ?? '')).toEqual(['', 'page-1', 'page-1', 'page-2']);
  });
});

describe('listUsers', () => {
  test('follows every page until the cursor is empty', async () => {
    fake.users = Array.from({ length: 5 }, (_, i) => rawUser(`U00${i}`));
    fake.pageSize = 2;
    expect((await client.listUsers()).map((u) => u.id)).toEqual(['U000', 'U001', 'U002', 'U003', 'U004']);
    expect(fake.log).toHaveLength(3);
  });

  test('deactivated accounts, bots and Slackbot are hidden unless asked for', async () => {
    fake.users = [
      rawUser('U0001'),
      rawUser('U0002', { deleted: true }),
      rawUser('B0003', { is_bot: true }),
      rawUser('USLACKBOT', { is_bot: false }),
    ];
    expect((await client.listUsers()).map((u) => u.id)).toEqual(['U0001']);
    expect((await client.listUsers({ includeDeleted: true, includeBots: true })).map((u) => u.id)).toEqual(['U0001', 'U0002', 'B0003', 'USLACKBOT']);
  });

  test('a user with no profile or empty strings does not crash and shows no display name', async () => {
    fake.users = [{ id: 'U0001', name: 'ghost' }, rawUser('U0002', { profile: { display_name: '', email: '' } })];
    const users = await client.listUsers();
    expect(users[0]).toMatchObject({ id: 'U0001', name: 'ghost', displayName: undefined, email: undefined });
    expect(users[1]).toMatchObject({ displayName: undefined, email: undefined });
  });

  test('a page without members is treated as empty', async () => {
    fake.queue.push({ status: 200, body: { ok: true } });
    expect(await client.listUsers()).toEqual([]);
  });
});
