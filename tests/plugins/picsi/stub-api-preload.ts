import { appendFileSync } from 'fs';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const user = { uid: '123', name: 'Pat', email: 'pat@example.com', role: 'Pro', creditsAll: 400, creditsRemain: 398, token: 'picsi-cli-test-secret' };

// Every child-process request is a fake. A new or unexpected path cannot reach the network.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'https://www.picsi.ai') throw new Error('Unexpected test origin');
  if (process.env.PICSI_TEST_LOG) appendFileSync(process.env.PICSI_TEST_LOG, url.pathname + '\n');
  if (new Headers(init?.headers).get('uk') !== user.token) return Response.json({ code: 90401, message: 'Session expired' });
  if (url.pathname === '/user/info') return Response.json({ code: 0, data: user });
  if (url.pathname === '/api/morph/token') return Response.json({ code: 0, data: { token: 'processing-token', count: 1, time: Date.now() } });
  if (url.pathname === '/api/morph/image') return Response.json({ code: 0, data: { output: image, userInfo: user } });
  throw new Error('Unexpected test path');
}) as typeof fetch;
