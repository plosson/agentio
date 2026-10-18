import { describe, expect, spyOn, test } from 'bun:test';
import { GChatClient } from '../../../../src/plugins/google/gchat/client';
import { CliError } from '../../../../src/utils/errors';

async function asyncFailure(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    return error as CliError;
  }
  throw new Error('expected a failure');
}

/** An OAuth client whose Chat API records the resource names it is asked for. */
function clientWithFakeChat() {
  const calls: Record<string, unknown>[] = [];
  const client = new GChatClient({ type: 'oauth', accessToken: 'at', refreshToken: 'rt', expiryDate: 0 } as never);
  const chat = {
    spaces: {
      get: async (params: { name: string }) => {
        calls.push({ op: 'spaces.get', ...params });
        if (params.name !== 'spaces/S1') throw new Error('404');
        return { data: { name: params.name } };
      },
      list: async () => ({ data: { spaces: [] } }),
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push({ op: 'messages.create', ...params });
          return { data: { name: 'spaces/S1/messages/NEW' } };
        },
        list: async (params: Record<string, unknown>) => {
          calls.push({ op: 'messages.list', ...params });
          return { data: { messages: [] } };
        },
        get: async (params: Record<string, unknown>) => {
          calls.push({ op: 'messages.get', ...params });
          return { data: { name: params.name, createTime: '2026-01-01T00:00:00Z' } };
        },
      },
    },
  };
  spyOn(client as never, 'getOAuthChatApi').mockImplementation((() => ({ auth: {}, chat })) as never);
  return { client, calls };
}

describe('GChatClient resource names', () => {
  test('send with --space spaces/S1 posts to spaces/S1, never spaces/spaces/S1', async () => {
    const { client, calls } = clientWithFakeChat();
    const result = await client.send({ text: 'hi', spaceId: 'spaces/S1' });
    expect(result.spaceId).toBe('S1');
    expect(calls.find(c => c.op === 'messages.create')?.parent).toBe('spaces/S1');
    expect(calls.some(c => String(c.name ?? c.parent).includes('spaces/spaces/'))).toBe(false);
  });

  test('get with the message name printed by list fetches that exact message', async () => {
    const { client, calls } = clientWithFakeChat();
    await client.get({ spaceId: 'spaces/S1', messageId: 'spaces/S1/messages/M1' });
    expect(calls.find(c => c.op === 'messages.get')?.name).toBe('spaces/S1/messages/M1');
  });

  test('get with a message from another space fails before calling the API', async () => {
    const { client, calls } = clientWithFakeChat();
    const error = await asyncFailure(() => client.get({ spaceId: 'S1', messageId: 'spaces/S2/messages/M1' }));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(calls.some(c => c.op === 'messages.get')).toBe(false);
  });

  test('list with the thread name printed by get filters on that exact thread', async () => {
    const { client, calls } = clientWithFakeChat();
    await client.list({ spaceId: 'S1', threadId: 'spaces/S1/threads/T1' });
    expect(calls.find(c => c.op === 'messages.list')?.filter).toBe('thread.name = "spaces/S1/threads/T1"');
  });

  test('list with a thread from another space fails before calling the API', async () => {
    const { client, calls } = clientWithFakeChat();
    const error = await asyncFailure(() => client.list({ spaceId: 'S1', threadId: 'spaces/S2/threads/T1' }));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.suggestion).toBe('Use --space S2');
    expect(calls.some(c => c.op === 'messages.list')).toBe(false);
  });

  test('send --thread replies in that thread and fails rather than starting a new one', async () => {
    const { client, calls } = clientWithFakeChat();
    await client.send({ text: 'hi', spaceId: 'S1', threadId: 'spaces/S1/threads/T1' });
    const create = calls.find(c => c.op === 'messages.create') as { requestBody: { thread?: { name: string } }; messageReplyOption?: string };
    expect(create.requestBody.thread?.name).toBe('spaces/S1/threads/T1');
    expect(create.messageReplyOption).toBe('REPLY_MESSAGE_OR_FAIL');
  });

  test('send without --thread sets no thread and no reply option', async () => {
    const { client, calls } = clientWithFakeChat();
    await client.send({ text: 'hi', spaceId: 'S1' });
    const create = calls.find(c => c.op === 'messages.create') as { requestBody: { thread?: unknown }; messageReplyOption?: string };
    expect(create.requestBody.thread).toBeUndefined();
    expect(create.messageReplyOption).toBeUndefined();
  });

  test('send --thread overrides a thread already in the --json payload', async () => {
    const { client, calls } = clientWithFakeChat();
    await client.send({ payload: { text: 'hi', thread: { name: 'spaces/S1/threads/OLD' } }, spaceId: 'S1', threadId: 'T1' });
    const create = calls.find(c => c.op === 'messages.create') as { requestBody: { thread?: { name: string } } };
    expect(create.requestBody.thread?.name).toBe('spaces/S1/threads/T1');
  });

  test('send --thread from another space fails before posting anything', async () => {
    const { client, calls } = clientWithFakeChat();
    const error = await asyncFailure(() => client.send({ text: 'hi', spaceId: 'S1', threadId: 'spaces/S2/threads/T1' }));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(calls.some(c => c.op === 'messages.create')).toBe(false);
  });

  test('send --thread on a webhook profile is refused instead of silently posting a new thread', async () => {
    const client = new GChatClient({ type: 'webhook', webhookUrl: 'https://chat.googleapis.com/v1/spaces/S1/messages?key=k' } as never);
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      const error = await asyncFailure(() => client.send({ text: 'hi', threadId: 'T1' }));
      expect(error.code).toBe('PERMISSION_DENIED');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('an unknown space still reports NOT_FOUND with the name as typed', async () => {
    const { client } = clientWithFakeChat();
    const error = await asyncFailure(() => client.send({ text: 'hi', spaceId: 'spaces/NOPE' }));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('NOPE');
  });
});
