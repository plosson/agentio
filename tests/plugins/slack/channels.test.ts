import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { checkChannelName, isChannelId, SlackClient } from '../../../src/plugins/slack/client';
import { caught, FakeSlack, fakeChannel, rawUser, TOKEN } from './fake-slack';

let fake: FakeSlack;
let client: SlackClient;

beforeEach(() => {
  fake = new FakeSlack();
  client = new SlackClient({ type: 'token', token: TOKEN }, { sleep: async () => {} });
});

afterEach(() => fake.stop());

const methods = () => fake.log.map((c) => c.url.replace('https://slack.com/api/', ''));
/** Calls that change something in Slack. */
const writes = () => methods().filter((m) => /create|rename|setTopic|setPurpose|invite|kick/.test(m));

describe('checkChannelName', () => {
  test('a leading # and surrounding spaces are dropped', () => {
    expect(checkChannelName('  #team-design ')).toBe('team-design');
  });

  test('uppercase, spaces, dots, unicode, ## and over-long names are refused, not rewritten', () => {
    for (const bad of ['Team', 'team design', 'team.design', 'équipe', '##team', 'a'.repeat(81), '', '#', 'team\nx']) {
      expect(() => checkChannelName(bad)).toThrow();
    }
  });

  test('80 characters is allowed', () => {
    expect(checkChannelName('a'.repeat(80))).toHaveLength(80);
  });

  test('channel ids are C… or G…, never user or DM ids', () => {
    expect(isChannelId('C0123ABC')).toBe(true);
    expect(isChannelId('G0123ABC')).toBe(true);
    for (const no of ['D0123ABC', 'U0123ABC', 'c0123abc', 'general']) expect(isChannelId(no)).toBe(false);
  });
});

describe('getChannel', () => {
  test('a name resolves through the list, an id through conversations.info', async () => {
    expect((await client.getChannel('#random')).id).toBe('C0RANDOM');
    expect((await client.getChannel('C0GENERAL')).name).toBe('general');
    expect(methods()).toEqual(['conversations.list', 'conversations.info']);
  });

  test('a name on page 3 of the list is found', async () => {
    fake.channelPageSize = 1;
    fake.channels.push(fakeChannel('C0THIRD', 'third'));
    expect((await client.getChannel('third')).id).toBe('C0THIRD');
  });

  test('an archived channel is found by name too, so a rename does not collide silently', async () => {
    fake.channels.push(fakeChannel('C0OLD', 'old', { is_archived: true }));
    expect((await client.getChannel('old')).isArchived).toBe(true);
  });

  test('a private channel you are not in is NOT_FOUND, by name and by id', async () => {
    fake.channels.push(fakeChannel('G0SECRET', 'secret', { is_private: true, members: ['U0001'] }));
    expect((await caught(client.getChannel('secret'))).code).toBe('NOT_FOUND');
    expect((await caught(client.getChannel('G0SECRET'))).code).toBe('NOT_FOUND');
  });

  test('a name that differs only in case does not match another channel', async () => {
    expect((await caught(client.getChannel('General'))).code).toBe('INVALID_PARAMS');
  });

  test('a missing groups:read scope is PERMISSION_DENIED naming it', async () => {
    fake.scopes.delete('groups:read');
    const err = await caught(client.listChannels());
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('groups:read');
  });
});

describe('createChannel', () => {
  test('creates, then sets topic and purpose', async () => {
    const channel = await client.createChannel('team-design', { topic: 'Reviews', purpose: 'Design work' });
    expect(channel).toMatchObject({ name: 'team-design', isPrivate: false, topic: 'Reviews', purpose: 'Design work' });
    expect(writes()).toEqual(['conversations.create', 'conversations.setTopic', 'conversations.setPurpose']);
  });

  test('--private creates a private channel', async () => {
    expect((await client.createChannel('hr', { isPrivate: true })).isPrivate).toBe(true);
    expect(fake.log[0].params.is_private).toBe('true');
  });

  test('an invalid name or a too-long topic is refused before anything is created', async () => {
    expect((await caught(client.createChannel('Team Design'))).code).toBe('INVALID_PARAMS');
    expect((await caught(client.createChannel('ok', { topic: 'x'.repeat(251) }))).code).toBe('INVALID_PARAMS');
    expect((await caught(client.createChannel('ok', { purpose: 'x'.repeat(251) }))).code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('a name already taken is a clear INVALID_PARAMS', async () => {
    const err = await caught(client.createChannel('general'));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('already exists');
  });

  test('when the topic fails after creation, the error says the channel exists and gives its id', async () => {
    fake.queue.push(
      { status: 200, body: { ok: true, channel: { id: 'C0MADE', name: 'made' } } },
      { status: 200, body: { ok: false, error: 'too_long' } },
    );
    const err = await caught(client.createChannel('made', { topic: 'Hello' }));
    expect(err.message).toContain('C0MADE');
    expect(err.message).toContain('was created');
    expect(err.suggestion).toContain('channels set C0MADE');
  });

  test('without a topic or purpose, only conversations.create is called', async () => {
    await client.createChannel('plain');
    expect(methods()).toEqual(['conversations.create']);
  });
});

describe('updateChannel', () => {
  test('nothing to change is refused before any request', async () => {
    expect((await caught(client.updateChannel('general', {}))).code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('an invalid new name is refused before any request', async () => {
    expect((await caught(client.updateChannel('general', { name: 'New Name' }))).code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('an empty topic clears it', async () => {
    fake.channels[0].topic.value = 'Old';
    const channel = await client.updateChannel('general', { topic: '' });
    expect(channel.topic).toBeUndefined();
    expect(fake.channels[0].topic.value).toBe('');
  });

  test('values equal to the current ones send no write', async () => {
    fake.channels[0].topic.value = 'Same';
    await client.updateChannel('general', { name: 'general', topic: 'Same' });
    expect(writes()).toEqual([]);
  });

  test('a rename to a taken name fails and sets nothing else', async () => {
    const err = await caught(client.updateChannel('general', { name: 'random', topic: 'x' }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(writes()).toEqual(['conversations.rename']);
    expect(fake.channels[0].topic.value).toBe('');
  });

  test('an archived channel cannot be changed', async () => {
    fake.channels[0].is_archived = true;
    expect((await caught(client.updateChannel('C0GENERAL', { topic: 'x' }))).code).toBe('INVALID_PARAMS');
  });
});

describe('inviteToChannel', () => {
  test('ids and emails are resolved and invited in one call', async () => {
    const result = await client.inviteToChannel('general', ['U0001', 'u0002@example.com']);
    expect(result.changed.map((u) => u.id)).toEqual(['U0001', 'U0002']);
    expect(fake.log.find((c) => c.url.endsWith('conversations.invite'))!.params.users).toBe('U0001,U0002');
  });

  test('one unknown email invites nobody', async () => {
    const err = await caught(client.inviteToChannel('general', ['U0001', 'nobody@example.com']));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('nobody@example.com');
    expect(err.message).toContain('Nothing was changed');
    expect(writes()).toEqual([]);
    expect(fake.channels[0].members).toEqual(['U0ADMIN']);
  });

  test('an invalid user argument invites nobody', async () => {
    expect((await caught(client.inviteToChannel('general', ['U0001', 'jane']))).code).toBe('INVALID_PARAMS');
    expect(writes()).toEqual([]);
  });

  test('existing members are skipped, and when all are members nothing is sent', async () => {
    fake.channels[0].members.push('U0001');
    const result = await client.inviteToChannel('general', ['U0001']);
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((u) => u.id)).toEqual(['U0001']);
    expect(writes()).toEqual([]);
  });

  test('the same person by id and by email is invited once', async () => {
    const result = await client.inviteToChannel('general', ['U0001', 'u0001@example.com', 'U0001']);
    expect(result.changed.map((u) => u.id)).toEqual(['U0001']);
    expect(fake.log.find((c) => c.url.endsWith('conversations.invite'))!.params.users).toBe('U0001');
  });

  test('an empty list or a blank user is refused before any request', async () => {
    expect((await caught(client.inviteToChannel('general', []))).code).toBe('INVALID_PARAMS');
    expect((await caught(client.inviteToChannel('general', ['U0001', ' ']))).code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('an archived channel is refused before anyone is looked up', async () => {
    fake.channels[0].is_archived = true;
    expect((await caught(client.inviteToChannel('general', ['U0001']))).code).toBe('INVALID_PARAMS');
    expect(writes()).toEqual([]);
  });

  test('a public channel you are not in gives PERMISSION_DENIED', async () => {
    fake.channels[0].members = [];
    expect((await caught(client.inviteToChannel('general', ['U0001']))).code).toBe('PERMISSION_DENIED');
  });

  test('a single-channel guest is refused with a clear message', async () => {
    fake.users.push(rawUser('U0GUEST', { is_restricted: true }));
    fake.inviteErrors.U0GUEST = 'ura_max_channels';
    const err = await caught(client.inviteToChannel('general', ['U0GUEST']));
    expect(err.message).toContain('single-channel guest');
  });

  test('a missing invite scope is PERMISSION_DENIED naming it', async () => {
    fake.scopes.delete('channels:write.invites');
    const err = await caught(client.inviteToChannel('general', ['U0001']));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('channels:write.invites');
  });

  test('members are read across every page before deciding who to skip', async () => {
    fake.channelPageSize = 1;
    fake.channels[0].members = ['U0ADMIN', 'U0002', 'U0001'];
    const result = await client.inviteToChannel('general', ['U0001']);
    expect(result.skipped.map((u) => u.id)).toEqual(['U0001']);
    expect(writes()).toEqual([]);
  });
});

describe('uninviteFromChannel', () => {
  beforeEach(() => { fake.channels[0].members.push('U0001', 'U0002'); });

  test('removes each member with one call per user', async () => {
    const result = await client.uninviteFromChannel('general', ['U0001', 'u0002@example.com']);
    expect(result.changed.map((u) => u.id)).toEqual(['U0001', 'U0002']);
    expect(writes()).toEqual(['conversations.kick', 'conversations.kick']);
    expect(fake.channels[0].members).toEqual(['U0ADMIN']);
  });

  test('one unknown email removes nobody', async () => {
    await caught(client.uninviteFromChannel('general', ['U0001', 'nobody@example.com']));
    expect(writes()).toEqual([]);
    expect(fake.channels[0].members).toContain('U0001');
  });

  test('non-members are skipped without a call', async () => {
    fake.users.push(rawUser('U0003'));
    const result = await client.uninviteFromChannel('general', ['U0003']);
    expect(result.skipped.map((u) => u.id)).toEqual(['U0003']);
    expect(writes()).toEqual([]);
  });

  test('removing yourself is refused with a clear message', async () => {
    fake.users.push(rawUser('U0ADMIN'));
    const err = await caught(client.uninviteFromChannel('general', ['U0ADMIN']));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('yourself');
  });

  test('a failure part-way says who was already removed', async () => {
    fake.kickErrors.U0002 = 'restricted_action';
    const err = await caught(client.uninviteFromChannel('general', ['U0001', 'U0002']));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('already removed: u0001@example.com');
    expect(fake.channels[0].members).not.toContain('U0001');
    expect(fake.channels[0].members).toContain('U0002');
  });

  test('a channel id for a channel you cannot see is NOT_FOUND before any user lookup', async () => {
    expect((await caught(client.uninviteFromChannel('C0NOPE', ['U0001']))).code).toBe('NOT_FOUND');
    expect(methods()).toEqual(['conversations.info']);
  });
});

describe('channelMembers', () => {
  test('members are shown as users, and an id unknown to users.list is kept as a bare id', async () => {
    fake.channels[0].members.push('U0001', 'U0GONE');
    const { members } = await client.channelMembers('general');
    expect(members.map((u) => u.id)).toEqual(['U0ADMIN', 'U0001', 'U0GONE']);
    expect(members[1].email).toBe('u0001@example.com');
    expect(members[2]).toMatchObject({ id: 'U0GONE', name: 'U0GONE' });
  });
});

describe('archive and unarchive', () => {
  test('archive then unarchive by name round-trips', async () => {
    expect(await client.archiveChannel('#random')).toMatchObject({ changed: true, channel: { isArchived: true } });
    expect(fake.channels[1].is_archived).toBe(true);
    expect(await client.unarchiveChannel('random')).toMatchObject({ changed: true, channel: { isArchived: false } });
    expect(fake.channels[1].is_archived).toBe(false);
  });

  test('archiving an archived channel sends nothing and says nothing changed', async () => {
    fake.channels[1].is_archived = true;
    expect((await client.archiveChannel('random')).changed).toBe(false);
    expect((await client.unarchiveChannel('general')).changed).toBe(false);
    expect(methods().filter((m) => m.includes('archive'))).toEqual([]);
  });

  test('the general channel cannot be archived, with a clear message', async () => {
    const err = await caught(client.archiveChannel('general'));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('general channel');
    expect(fake.channels[0].is_archived).toBe(false);
  });

  test('a channel that does not exist is NOT_FOUND and nothing is archived', async () => {
    expect((await caught(client.archiveChannel('no-such-channel'))).code).toBe('NOT_FOUND');
    expect((await caught(client.archiveChannel('C0NOPE'))).code).toBe('NOT_FOUND');
    expect(methods().filter((m) => m.includes('archive'))).toEqual([]);
  });

  test('an invalid name is refused before any request', async () => {
    expect((await caught(client.archiveChannel('Random'))).code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('a missing groups:write scope on a private channel is PERMISSION_DENIED naming it', async () => {
    fake.channels.push(fakeChannel('G0HR', 'hr', { is_private: true }));
    fake.scopes.delete('groups:write');
    const err = await caught(client.archiveChannel('hr'));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('groups:write');
  });

  test('a channel archived meanwhile by someone else gives an API_ERROR, not a false success', async () => {
    fake.queue.push(
      { status: 200, body: { ok: true, channel: { id: 'C0RANDOM', name: 'random', is_archived: false } } },
      { status: 200, body: { ok: false, error: 'already_archived' } },
    );
    const err = await caught(client.archiveChannel('C0RANDOM'));
    expect(err.code).toBe('API_ERROR');
    expect(err.message).toContain('already_archived');
  });
});

describe('bulk lookup for invite and uninvite', () => {
  beforeEach(() => {
    fake.users = Array.from({ length: 50 }, (_, i) => rawUser(`U1${String(i).padStart(3, '0')}`));
  });

  const emails = (n: number) => Array.from({ length: n }, (_, i) => `u1${String(i).padStart(3, '0')}@example.com`);
  const lookups = () => methods().filter((m) => m === 'users.lookupByEmail' || m === 'users.info');

  test('50 emails cost one users.list and no per-user lookups', async () => {
    const result = await client.inviteToChannel('general', emails(50));
    expect(result.changed).toHaveLength(50);
    expect(lookups()).toEqual([]);
    expect(methods().filter((m) => m === 'users.list')).toHaveLength(1);
    expect(methods().filter((m) => m === 'conversations.invite')).toHaveLength(1);
  });

  test('users.list across pages still resolves everyone', async () => {
    fake.pageSize = 7;
    const result = await client.inviteToChannel('general', emails(50));
    expect(result.changed).toHaveLength(50);
    expect(lookups()).toEqual([]);
  });

  test('emails match whatever their case', async () => {
    const result = await client.inviteToChannel('general', ['U1000@EXAMPLE.COM', 'u1001@Example.com', 'U1002']);
    expect(result.changed.map((u) => u.id)).toEqual(['U1000', 'U1001', 'U1002']);
    expect(lookups()).toEqual([]);
  });

  test('two users still use one lookup each, not users.list', async () => {
    await client.inviteToChannel('general', emails(2));
    expect(methods().filter((m) => m === 'users.list')).toEqual([]);
    expect(lookups()).toHaveLength(2);
  });

  test('an email missing from users.list falls back to a lookup, and when Slack also does not know it nobody is invited', async () => {
    const err = await caught(client.inviteToChannel('general', [...emails(5), 'ghost@example.com']));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('ghost@example.com');
    expect(lookups()).toEqual(['users.lookupByEmail']);
    expect(writes()).toEqual([]);
  });

  test('an email users.list hides (no email field) but Slack resolves is still invited', async () => {
    fake.users.push(rawUser('U2HIDDEN', { profile: { email: 'hidden@example.com' } }));
    const listed = fake.users.map((u) => (u.id === 'U2HIDDEN' ? { ...u, profile: {} } : u));
    // Scripted in call order: conversations.list (the channel name), then users.list.
    fake.queue.push(
      { status: 200, body: { ok: true, channels: [{ id: 'C0GENERAL', name: 'general', is_member: true }], response_metadata: { next_cursor: '' } } },
      { status: 200, body: { ok: true, members: listed, response_metadata: { next_cursor: '' } } },
    );
    const result = await client.inviteToChannel('general', [...emails(3), 'hidden@example.com']);
    expect(result.changed.map((u) => u.id)).toContain('U2HIDDEN');
    expect(lookups()).toEqual(['users.lookupByEmail']);
  });

  test('a malformed user among many is refused before the channel or the directory is read', async () => {
    const err = await caught(client.inviteToChannel('general', [...emails(10), 'not an email']));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('not an email');
    expect(fake.log).toHaveLength(0);
  });

  test('uninvite uses the same single users.list', async () => {
    fake.channels[0].members.push(...fake.users.slice(0, 5).map((u) => u.id as string));
    const result = await client.uninviteFromChannel('general', emails(5));
    expect(result.changed).toHaveLength(5);
    expect(lookups()).toEqual([]);
    expect(methods().filter((m) => m === 'users.list')).toHaveLength(1);
  });

  test('a rate-limited users.list is retried, not turned into per-user lookups', async () => {
    fake.queue.push(
      { status: 200, body: { ok: true, channels: [{ id: 'C0GENERAL', name: 'general', is_member: true }], response_metadata: { next_cursor: '' } } },
      { status: 429, headers: { 'Retry-After': '1' } },
    );
    const result = await client.inviteToChannel('general', emails(10));
    expect(result.changed).toHaveLength(10);
    expect(lookups()).toEqual([]);
  });
});

describe('leaveChannels', () => {
  beforeEach(() => {
    fake.channels.push(
      fakeChannel('G0HR', 'hr', { is_private: true, members: ['U0ADMIN', 'U0001'] }),
      fakeChannel('G0SOLO', 'solo', { is_private: true, members: ['U0ADMIN'] }),
      fakeChannel('C0OUT', 'out', { members: ['U0001'] }),
    );
  });
  const leaves = () => methods().filter((m) => m === 'conversations.leave');

  test('leaves a public and a private channel, by name and by id', async () => {
    const results = await client.leaveChannels(['#random', 'G0HR']);
    expect(results.map((r) => [r.channel.name, r.changed])).toEqual([['random', true], ['hr', true]]);
    expect(fake.channels.find((c) => c.id === 'C0RANDOM')!.members).not.toContain('U0ADMIN');
    expect(fake.channels.find((c) => c.id === 'G0HR')!.members).toEqual(['U0001']);
  });

  test('one wrong name leaves no channel at all', async () => {
    const err = await caught(client.leaveChannels(['random', 'hr', 'no-such-channel']));
    expect(err.code).toBe('NOT_FOUND');
    expect(leaves()).toEqual([]);
    expect(fake.channels.find((c) => c.id === 'G0HR')!.members).toContain('U0ADMIN');
  });

  test('a channel you are not in is skipped without a call', async () => {
    const results = await client.leaveChannels(['out']);
    expect(results[0].changed).toBe(false);
    expect(leaves()).toEqual([]);
  });

  test('the same channel by name and id is left once', async () => {
    const results = await client.leaveChannels(['random', 'C0RANDOM', '#random']);
    expect(results).toHaveLength(1);
    expect(leaves()).toHaveLength(1);
  });

  test('the last member of a private channel is refused with a clear message', async () => {
    const err = await caught(client.leaveChannels(['solo']));
    expect(err.message).toContain('last member');
    expect(fake.channels.find((c) => c.id === 'G0SOLO')!.members).toEqual(['U0ADMIN']);
  });

  test('a failure part-way names the channels already left', async () => {
    const err = await caught(client.leaveChannels(['random', 'hr', 'solo']));
    expect(err.message).toContain('already left: #random, #hr');
  });

  test('general cannot be left', async () => {
    expect((await caught(client.leaveChannels(['general']))).message).toContain('general channel');
  });

  test('a missing channels:write scope names it and leaves nothing', async () => {
    fake.scopes.delete('channels:write');
    const err = await caught(client.leaveChannels(['random']));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('channels:write');
  });

  test('no channels or a blank one is refused before any request', async () => {
    expect((await caught(client.leaveChannels([]))).code).toBe('INVALID_PARAMS');
    expect((await caught(client.leaveChannels(['random', '  ']))).code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });
});
