import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { encodeToken } from '../../src/auth/token';

// Module mocks last for the whole process: keep the real exports and put them
// back in afterAll, so files that import cli.ts later still get a version.
const real = { ...(await import('../../src/utils/version')) };
mock.module('../../src/utils/version', () => ({
  agentioVersion: () => { throw new Error('package.json unreadable'); },
}));

afterAll(() => { mock.module('../../src/utils/version', () => real); });

const { resetRemoteCache } = await import('../../src/auth/remote');
const { getCredentials } = await import('../../src/auth/token-store');
const { resetUsageContext, setUsageCommand } = await import('../../src/usage/context');
const { USAGE_HEADERS } = await import('../../src/usage/event');

let headersSeen: Headers[] = [];
let server: ReturnType<typeof Bun.serve>;
let home = '';
let savedHome: string | undefined;
let url = '';

beforeAll(async () => {
  const { mkdtemp } = await import('fs/promises');
  const { tmpdir } = await import('os');
  savedHome = process.env.HOME;
  home = await mkdtemp(`${tmpdir()}/agentio-remote-usage-failsafe-`);
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
  url = `http://127.0.0.1:${server.port}`;
  process.env.AGENTIO_TOKEN = encodeToken({ url, kid: 'kid', secret: 'secret' });
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

afterEach(() => resetUsageContext());

test('usage headers that cannot be built do not break the credential request', async () => {
  setUsageCommand(['gmail', 'send']);
  expect(await getCredentials<{ access_token: string }>('gmail', 'work')).toEqual({ access_token: 'x' });
  const sent = headersSeen.at(-1)!;
  expect(sent.has(USAGE_HEADERS.command)).toBe(false);
  expect(sent.has(USAGE_HEADERS.host)).toBe(false);
  expect(sent.has(USAGE_HEADERS.version)).toBe(false);
});
