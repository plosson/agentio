import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SlackClient } from '../../../src/plugins/slack/client';
import { printSlackSendResult } from '../../../src/plugins/slack/output';
import { caught, FakeSlack, fakeChannel, rawUser, TOKEN } from './fake-slack';

let fake: FakeSlack;
let client: SlackClient;

beforeEach(() => {
  fake = new FakeSlack();
  fake.users.push(rawUser('U0JANE', { name: 'jane', profile: { real_name: 'Jane Doe', display_name: 'Janie', email: 'jane@example.com' } }));
  fake.channels.push(fakeChannel('G0PRIVATE', 'secret-room', { is_private: true }));
  client = new SlackClient({ type: 'token', token: TOKEN }, { sleep: async () => {} });
});

afterEach(() => fake.stop());

const methods = () => fake.log.map((c) => c.url.replace('https://slack.com/api/', ''));

describe('slack send --channel with a user token', () => {
  test('a channel by #name is looked up, then posted to', async () => {
    const result = await client.send({ text: 'release is out', channel: '#general' });
    expect(result).toEqual({ success: true, isJsonPayload: false, channelId: 'C0GENERAL', target: '#general', ts: '1793000000.000001' });
    expect(fake.posted).toEqual([{ channel: 'C0GENERAL', text: 'release is out' }]);
  });

  test('a channel name without # and a private channel you are in both work', async () => {
    await client.send({ text: 'a', channel: 'random' });
    await client.send({ text: 'b', channel: 'secret-room' });
    expect(fake.posted.map((p) => p.channel)).toEqual(['C0RANDOM', 'G0PRIVATE']);
  });

  test('a channel id is posted to directly, with no lookup', async () => {
    await client.send({ text: 'hi', channel: 'C0GENERAL' });
    expect(methods()).toEqual(['chat.postMessage']);
  });

  test('@handle opens the DM with that member and posts there', async () => {
    const result = await client.send({ text: 'review?', channel: '@jane' });
    expect(methods()).toEqual(['users.list', 'conversations.open', 'chat.postMessage']);
    expect(fake.log[1].params).toEqual({ users: 'U0JANE' });
    expect(result.target).toBe('@jane');
    expect(fake.posted[0]).toEqual({ channel: 'D00JANE', text: 'review?' });
  });

  test('@display name matches when no username does, case-insensitively', async () => {
    await client.send({ text: 'x', channel: '@JANIE' });
    expect(fake.posted[0].channel).toBe('D00JANE');
  });

  test('an email or user id resolves the member without listing everyone', async () => {
    await client.send({ text: 'x', channel: 'jane@example.com' });
    await client.send({ text: 'y', channel: 'U0JANE' });
    await client.send({ text: 'z', channel: '@U0JANE' });
    expect(methods()).not.toContain('users.list');
    expect(fake.posted.map((p) => p.channel)).toEqual(['D00JANE', 'D00JANE', 'D00JANE']);
  });

  test('a DM id is posted to directly', async () => {
    fake.channels.push(fakeChannel('D0EXIST', '', { is_im: true, user: 'U0001', members: ['U0ADMIN', 'U0001'] }));
    await client.send({ text: 'x', channel: 'D0EXIST' });
    expect(methods()).toEqual(['chat.postMessage']);
  });

  test('an unknown handle is NOT_FOUND and nothing is posted', async () => {
    const err = await caught(client.send({ text: 'x', channel: '@nobody' }));
    expect(err.code).toBe('NOT_FOUND');
    expect(fake.posted).toHaveLength(0);
  });

  test('a handle shared by two members is refused, naming both ids', async () => {
    fake.users.push(rawUser('U0JANE2', { name: 'jane2', profile: { display_name: 'Janie' } }));
    const err = await caught(client.send({ text: 'x', channel: '@janie' }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('U0JANE');
    expect(err.message).toContain('U0JANE2');
    expect(fake.posted).toHaveLength(0);
  });

  test('an unknown channel name is NOT_FOUND and nothing is posted', async () => {
    const err = await caught(client.send({ text: 'x', channel: '#does-not-exist' }));
    expect(err.code).toBe('NOT_FOUND');
    expect(fake.posted).toHaveLength(0);
  });

  test('a Block Kit payload is sent form-encoded, its blocks as JSON, and cannot pick its own channel', async () => {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*hi*' } }];
    const result = await client.send({ payload: { text: 'hi', blocks, channel: 'C0RANDOM' }, channel: '#general' });
    expect(result.isJsonPayload).toBe(true);
    expect(fake.posted[0]).toEqual({ channel: 'C0GENERAL', text: 'hi', blocks: JSON.stringify(blocks) });
  });

  test('missing chat:write is PERMISSION_DENIED and names the scope', async () => {
    fake.scopes.delete('chat:write');
    const err = await caught(client.send({ text: 'x', channel: 'C0GENERAL' }));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('chat:write');
  });

  test('missing im:write is PERMISSION_DENIED before anything is posted', async () => {
    fake.scopes.delete('im:write');
    const err = await caught(client.send({ text: 'x', channel: 'U0JANE' }));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('im:write');
    expect(fake.posted).toHaveLength(0);
  });
});

describe('slack send with a webhook', () => {
  test('--channel is refused: a webhook posts only to its own channel', async () => {
    const webhook = new SlackClient({ type: 'webhook', webhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    const err = await caught(webhook.send({ text: 'x', channel: '#general' }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });
});

describe('send output', () => {
  test('a token send prints the channel, how it was named, and the timestamp', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      printSlackSendResult({ success: true, isJsonPayload: false, channelId: 'D00JANE', target: '@jane', ts: '1793000000.000001' });
      expect(log.mock.calls.map((c) => c[0])).toEqual(['Message sent', 'Channel: D00JANE (@jane)', 'Timestamp: 1793000000.000001']);
    } finally {
      log.mockRestore();
    }
  });
});
