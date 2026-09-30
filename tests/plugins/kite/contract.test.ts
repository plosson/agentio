import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { KiteClient } from '../../../src/plugins/kite/client';
import { kiteDeviceLogin } from '../../../src/plugins/kite/device-auth';
import { CliError } from '../../../src/utils/errors';
import { caught } from './fake-kite';

/**
 * Opt-in: the fake Kite (fake-kite.ts) checked against a real one. Runs only
 * with a local Kite dev server, never a deployed one:
 *
 *   cd open-artifact && SIGNUP_MODE=open BASE_URL=http://localhost:4010 PORT=4010 \
 *     SESSION_SECRET=$(openssl rand -hex 32) DATABASE_PATH=/tmp/kite-contract.db \
 *     pnpm --filter @open-artifact/server dev > /tmp/kite-contract.log
 *   KITE_CONTRACT_URL=http://localhost:4010 KITE_CONTRACT_LOG=/tmp/kite-contract.log \
 *     bun test tests/plugins/kite/contract.test.ts
 *
 * With no mail server, Kite prints sign-in codes to its output, which is how
 * this test signs a browser session in to approve the device code.
 */

const BASE = process.env.KITE_CONTRACT_URL?.replace(/\/+$/, '');
const LOG = process.env.KITE_CONTRACT_LOG;

function isLocal(url: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}

if (BASE && !isLocal(BASE)) {
  throw new Error(`KITE_CONTRACT_URL must point at a local Kite, not ${BASE}`);
}

const run = BASE && LOG ? describe : describe.skip;

/** The last sign-in code the server printed for `email`. */
async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const log = readFileSync(LOG!, 'utf8');
    const matches = [...log.matchAll(/Email to: (\S+)\nSubject: +([0-9A-Z ]+?) is your/g)].filter((m) => m[1] === email);
    if (matches.length) return matches[matches.length - 1][2].replace(/\s/g, '');
    await Bun.sleep(100);
  }
  throw new Error(`no sign-in code for ${email} in ${LOG}`);
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

/** A browser session for `email`, as the approval page would have. */
async function browserSession(email: string): Promise<string> {
  const before = readFileSync(LOG!, 'utf8').length;
  expect((await post('/api/auth/code', { email })).status).toBe(200);
  while (readFileSync(LOG!, 'utf8').length === before) await Bun.sleep(50);
  const res = await post('/api/auth/verify-code', { email, code: await codeFor(email) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error('verify-code set no session cookie');
  return cookie.split(';')[0];
}

/** A CLI token through the device flow, approved by a browser session. */
async function deviceToken(email: string): Promise<string> {
  let approval: Promise<void> = Promise.resolve();
  const { token } = await kiteDeviceLogin({
    baseUrl: BASE!,
    label: 'agentio contract test',
    onCode: ({ userCode, verificationUrl }) => {
      expect(new URL(verificationUrl).origin).toBe(new URL(BASE!).origin);
      approval = (async () => {
        const cookie = await browserSession(email);
        const res = await post('/api/auth/device/approve', { userCode }, cookie);
        expect(res.status).toBe(200);
      })();
    },
  });
  await approval;
  return token;
}

run('contract with a real Kite', () => {
  const stamp = Date.now();
  const ME = `agentio-contract-${stamp}@example.com`;
  const OTHER = `agentio-contract-other-${stamp}@example.com`;

  test('one pass of every operation', async () => {
    const client = new KiteClient({ baseUrl: BASE!, token: await deviceToken(ME) });
    const other = new KiteClient({ baseUrl: BASE!, token: await deviceToken(OTHER) });

    expect(await client.validate()).toEqual({ valid: true, info: ME });

    // Publish, read, update, conflict.
    const doc = await client.publish({ type: 'markdown', content: '# Contract\n\nexact rendered text here', title: 'Contract' });
    expect(Object.keys(doc).sort()).toEqual(['id', 'title', 'type', 'updated', 'url', 'version']);
    expect(doc.id).toStartWith('art_');
    expect(doc.version).toBe(1);
    expect((await client.get(doc.id)).content).toBe('# Contract\n\nexact rendered text here');
    expect((await client.get(doc.url)).id).toBe(doc.id);
    const v2 = await client.update(doc.id, { type: 'markdown', content: '# Contract\n\nexact rendered text here, v2' });
    expect(v2.version).toBe(2);
    const stale = await client.raw('PUT', `/api/artifacts/${doc.id}`, { body: { type: 'markdown', content: 'x', baseVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(client.errorFor(stale).message).toContain('now version 2, you had 1');
    expect((await caught(client.publish({ type: 'markdown', content: '' }))).code).toBe('INVALID_PARAMS');
    expect((await client.list()).map((d) => d.id)).toContain(doc.id);

    // Someone else's document is not found, never forbidden.
    expect((await caught(other.get(doc.id))).code).toBe('NOT_FOUND');
    expect((await caught(other.update(doc.id, { type: 'markdown', content: 'x' }))).code).toBe('NOT_FOUND');
    expect((await caught(other.sharing(doc.id))).code).toBe('NOT_FOUND');

    // Sharing.
    expect(await client.sharing(doc.id)).toEqual({ id: doc.id, isPublic: false, people: [], domains: [], expiresAt: null });
    expect((await client.share(doc.id, OTHER)).notified).toBe(true);
    expect((await client.share(doc.id, OTHER)).notified).toBe(false);
    expect((await client.share(doc.id, 'example.org')).domains).toContain('example.org');
    expect((await caught(client.share(doc.id, 'gmail.com'))).code).toBe('INVALID_PARAMS');
    expect((await client.unshare(doc.id, 'example.org')).domains).not.toContain('example.org');
    expect((await caught(client.unshare(doc.id, 'nobody.example'))).code).toBe('NOT_FOUND');
    expect((await client.setPublic(doc.id, true)).isPublic).toBe(true);
    expect((await client.setPublic(doc.id, false)).isPublic).toBe(false);
    expect((await client.setExpiry(doc.id, '30d')).expiresAt).toBeString();
    expect((await client.setExpiry(doc.id, 'forever')).expiresAt).toBeNull();

    // Comments.
    const whole = await client.comment(doc.id, { body: 'On the whole thing' });
    expect(whole.mentions).toBeDefined();
    const passage = await client.comment(doc.id, { body: 'On a passage', snippet: 'exact rendered text here' });
    expect(passage.anchorLost).toBe(false);
    expect((await caught(client.comment(doc.id, { body: 'x', snippet: 'short' }))).code).toBe('INVALID_PARAMS');
    const reply = await other.reply(whole.id, 'A reply from someone it is shared with');
    expect(reply.author).toBe(OTHER);
    expect((await caught(other.setThreadStatus(whole.id, 'resolved'))).code).toBe('PERMISSION_DENIED');
    expect((await client.setThreadStatus(whole.id, 'resolved')).status).toBe('resolved');
    expect((await client.comments(doc.id, { status: 'resolved' })).map((t) => t.id)).toEqual([whole.id]);
    expect((await client.setThreadStatus(whole.id, 'open')).status).toBe('open');
    const threads = await client.comments(doc.id);
    expect(threads.map((t) => t.id).sort()).toEqual([whole.id, passage.id].sort());
    expect(threads[0]).toHaveProperty('anchorDrifted');
    const since = await client.comments(doc.id, { since: reply.createdAt });
    expect(since).toEqual([]);

    // Delete, and a dead token.
    await client.delete(doc.id);
    expect((await caught(client.get(doc.id))).code).toBe('NOT_FOUND');
    const dead = new KiteClient({ baseUrl: BASE!, token: 'not-a-token' });
    expect((await caught(dead.list())).code).toBe('AUTH_EXPIRED');
  }, 120_000);
});
