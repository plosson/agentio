import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { encodeToken } from '../../src/auth/token';

// Module mocks last for the whole process: keep the real exports and put them
// back in afterAll.
const real = { ...(await import('os')) };
let fakeHost = 'box.lan';
mock.module('os', () => ({ ...real, hostname: () => fakeHost }));

afterAll(() => { mock.module('os', () => real); });

const { resetRemoteCache } = await import('../../src/auth/remote');
const { getCredentials } = await import('../../src/auth/token-store');
const { resetUsageContext, setUsageCommand } = await import('../../src/usage/context');
const { USAGE_HEADERS } = await import('../../src/usage/event');

let headersSeen: Headers[] = [];
let server: ReturnType<typeof Bun.serve>;
let home = '';
let savedHome: string | undefined;

beforeAll(async () => {
  const { mkdtemp } = await import('fs/promises');
  savedHome = process.env.HOME;
  home = await mkdtemp(`${real.tmpdir()}/agentio-remote-usage-hostname-`);
  process.env.HOME = home;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      headersSeen.push(req.headers);
      return new Response(JSON.stringify({ credentials: { access_token: 'x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  process.env.AGENTIO_TOKEN = encodeToken({ url: `http://127.0.0.1:${server.port}`, kid: 'kid', secret: 'secret' });
  resetRemoteCache();
});

afterAll(async () => {
  server.stop(true);
  delete process.env.AGENTIO_TOKEN;
  resetRemoteCache();
  process.env.HOME = savedHome;
  const { rm } = await import('fs/promises');
  await rm(home, { recursive: true, force: true });
});

afterEach(() => { resetUsageContext(); fakeHost = 'box.lan'; });

test.each(['Pascal’s-Mac', 'box\nX: 1', 'h'.repeat(65)])('a host name %p cannot fail the credential request', async (name) => {
  fakeHost = name;
  setUsageCommand(['gmail', 'send']);
  expect(await getCredentials<{ access_token: string }>('gmail', 'work')).toEqual({ access_token: 'x' });
  const sent = headersSeen.at(-1)!;
  expect(sent.has(USAGE_HEADERS.host)).toBe(false);
  expect(sent.get(USAGE_HEADERS.command)).toBe('gmail send');
});

test('a valid host name is sent', async () => {
  setUsageCommand(['gmail', 'send']);
  await getCredentials('gmail', 'work');
  expect(headersSeen.at(-1)!.get(USAGE_HEADERS.host)).toBe('box.lan');
});
