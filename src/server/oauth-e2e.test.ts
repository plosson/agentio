import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Subprocess } from 'bun';

/**
 * End-to-end test for the full MCP OAuth flow against a real `agentio
 * server` subprocess. This is the closest we get to "what Claude Code
 * actually does" without involving Claude Code itself:
 *
 *   1. Discover OAuth metadata (RFC 9728 + RFC 8414).
 *   2. POST /register (Dynamic Client Registration).
 *   3. POST /authorize with the API key from the server's stdout.
 *   4. POST /token to exchange the auth code (with PKCE verifier).
 *   5. Use the bearer on /mcp.
 *
 * Each test runs in an isolated `mkdtemp` HOME so it never touches the
 * developer's real config.
 */

interface RunningServer {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  apiKey: string;
  port: number;
  baseUrl: string;
}

let tempHome = '';
let active: RunningServer | null = null;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-server-e2e-'));
});

afterEach(async () => {
  if (active) {
    try {
      active.proc.kill('SIGTERM');
      await Promise.race([
        active.proc.exited,
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000)),
      ]);
    } catch {
      try {
        active.proc.kill('SIGKILL');
        await active.proc.exited;
      } catch {
        /* ignore */
      }
    }
    active = null;
  }
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
    tempHome = '';
  }
});

async function findFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== 'number') throw new Error('no port');
  return port;
}

async function startServer(): Promise<RunningServer> {
  const port = await findFreePort();
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      'src/index.ts',
      'server',
      'start',
      '--foreground',
      '--port',
      String(port),
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: tempHome },
    }
  );

  const decoder = new TextDecoder();
  let buffer = '';
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + 10_000;
  try {
    while (!buffer.includes('Server ready')) {
      if (Date.now() > deadline) {
        proc.kill('SIGKILL');
        throw new Error(`startup timeout. stdout:\n${buffer}`);
      }
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            Math.max(100, deadline - Date.now())
          )
        ),
      ]);
      if (done) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(
          `child exited or timed out. stdout:\n${buffer}\nstderr:\n${stderr}`
        );
      }
      buffer += decoder.decode(value);
    }
  } finally {
    reader.releaseLock();
  }

  const apiKey = buffer.match(/API Key: (\S+)/)?.[1] ?? '';
  if (!apiKey) {
    proc.kill('SIGKILL');
    throw new Error(`could not parse API key from stdout:\n${buffer}`);
  }

  const running: RunningServer = {
    proc: proc as Subprocess<'ignore', 'pipe', 'pipe'>,
    apiKey,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  };
  active = running;
  return running;
}

function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = 'verifier_' + 'a'.repeat(54); // 63 chars, all valid
  const challenge = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
  return { verifier, challenge };
}

interface DiscoveredEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  issuer: string;
}

async function discoverMetadata(
  baseUrl: string
): Promise<DiscoveredEndpoints> {
  const prRes = await fetch(
    `${baseUrl}/.well-known/oauth-protected-resource`
  );
  expect(prRes.status).toBe(200);
  const pr = (await prRes.json()) as Record<string, unknown>;
  const authServers = pr.authorization_servers as string[];
  expect(authServers).toHaveLength(1);

  const asRes = await fetch(
    `${authServers[0]}/.well-known/oauth-authorization-server`
  );
  expect(asRes.status).toBe(200);
  return (await asRes.json()) as DiscoveredEndpoints;
}

async function dynamicallyRegister(
  endpoint: string,
  redirectUri: string
): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'E2E Test Client',
      redirect_uris: [redirectUri],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  return body.client_id as string;
}

/* ------------------------------------------------------------------ */
/* the actual end-to-end flow                                          */
/* ------------------------------------------------------------------ */

describe('end-to-end OAuth flow', () => {
  test('complete happy path: discover → register → authorize → token → /mcp', async () => {
    const server = await startServer();
    const redirectUri = 'http://localhost:53682/callback';
    const { verifier, challenge } = makePkcePair();

    // 1. Discover metadata.
    const meta = await discoverMetadata(server.baseUrl);
    expect(meta.issuer).toBe(server.baseUrl);
    expect(meta.authorization_endpoint).toBe(`${server.baseUrl}/authorize`);
    expect(meta.token_endpoint).toBe(`${server.baseUrl}/token`);
    expect(meta.registration_endpoint).toBe(`${server.baseUrl}/register`);

    // 2. Dynamic Client Registration.
    const clientId = await dynamicallyRegister(
      meta.registration_endpoint,
      redirectUri
    );
    expect(clientId).toMatch(/^cli_/);

    // 3. POST /authorize with the operator API key.
    const authForm = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'opaque-state-value',
      scope: 'mcp',
      api_key: server.apiKey,
    });
    const authRes = await fetch(meta.authorization_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: authForm.toString(),
      redirect: 'manual',
    });
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get('location');
    expect(location).toBeDefined();
    const locUrl = new URL(location!);
    expect(`${locUrl.origin}${locUrl.pathname}`).toBe(redirectUri);
    const code = locUrl.searchParams.get('code');
    const state = locUrl.searchParams.get('state');
    expect(code).toBeDefined();
    expect(state).toBe('opaque-state-value');

    // 4. POST /token to exchange the code.
    const tokenRes = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
    const accessToken = tokenBody.access_token as string;
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.expires_in).toBe(30 * 24 * 60 * 60);

    // 5. Use the bearer on /mcp (Phase 3 stub body).
    const mcpRes = await fetch(`${server.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as Record<string, unknown>;
    expect(mcpBody.phase).toBe(3);
    expect(mcpBody.clientId).toBe(clientId);
    expect(mcpBody.scope).toBe('mcp');
  });

  test('/mcp without bearer returns 401 + WWW-Authenticate (the trigger)', async () => {
    const server = await startServer();
    const res = await fetch(`${server.baseUrl}/mcp`);
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain('Bearer');
    expect(wwwAuth).toContain(
      `resource_metadata="${server.baseUrl}/.well-known/oauth-protected-resource"`
    );
  });

  test('wrong API key at /authorize re-renders form, no code issued', async () => {
    const server = await startServer();
    const redirectUri = 'http://localhost:53682/callback';
    const { challenge } = makePkcePair();
    const meta = await discoverMetadata(server.baseUrl);
    const clientId = await dynamicallyRegister(
      meta.registration_endpoint,
      redirectUri
    );

    const res = await fetch(meta.authorization_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 's',
        scope: '',
        api_key: 'srv_definitely_wrong',
      }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('Invalid API key');
  });

  test('reusing an auth code at /token a second time fails', async () => {
    const server = await startServer();
    const redirectUri = 'http://localhost:53682/callback';
    const { verifier, challenge } = makePkcePair();
    const meta = await discoverMetadata(server.baseUrl);
    const clientId = await dynamicallyRegister(
      meta.registration_endpoint,
      redirectUri
    );

    const authRes = await fetch(meta.authorization_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: server.apiKey,
      }).toString(),
      redirect: 'manual',
    });
    const code = new URL(authRes.headers.get('location')!).searchParams.get(
      'code'
    )!;

    // First exchange — succeeds.
    const first = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    expect(first.status).toBe(200);

    // Second exchange — fails.
    const second = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    expect(second.status).toBe(400);
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  test('wrong PKCE verifier at /token fails AND consumes the code', async () => {
    const server = await startServer();
    const redirectUri = 'http://localhost:53682/callback';
    const { verifier, challenge } = makePkcePair();
    const meta = await discoverMetadata(server.baseUrl);
    const clientId = await dynamicallyRegister(
      meta.registration_endpoint,
      redirectUri
    );

    const authRes = await fetch(meta.authorization_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: server.apiKey,
      }).toString(),
      redirect: 'manual',
    });
    const code = new URL(authRes.headers.get('location')!).searchParams.get(
      'code'
    )!;

    // Wrong verifier first.
    const wrongVerifier = 'verifier_' + 'b'.repeat(54);
    const wrong = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: wrongVerifier,
      }).toString(),
    });
    expect(wrong.status).toBe(400);

    // The correct verifier should also fail now — code is consumed.
    const right = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    expect(right.status).toBe(400);
  });

  test('issued tokens persist across server restarts', async () => {
    // First boot: do the OAuth dance, get a token.
    const server1 = await startServer();
    const redirectUri = 'http://localhost:53682/callback';
    const { verifier, challenge } = makePkcePair();
    const meta = await discoverMetadata(server1.baseUrl);
    const clientId = await dynamicallyRegister(
      meta.registration_endpoint,
      redirectUri
    );
    const authRes = await fetch(meta.authorization_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: server1.apiKey,
      }).toString(),
      redirect: 'manual',
    });
    const code = new URL(authRes.headers.get('location')!).searchParams.get(
      'code'
    )!;
    const tokenRes = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    const accessToken = ((await tokenRes.json()) as Record<string, unknown>)
      .access_token as string;

    // Stop server1.
    server1.proc.kill('SIGTERM');
    await server1.proc.exited;
    active = null;

    // Boot a fresh server (same HOME, same config, same persisted state).
    const server2 = await startServer();
    expect(server2.apiKey).toBe(server1.apiKey); // also persisted

    // The bearer issued under server1 should still work on server2.
    const mcpRes = await fetch(`${server2.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(mcpRes.status).toBe(200);
    const body = (await mcpRes.json()) as Record<string, unknown>;
    expect(body.clientId).toBe(clientId);
  });

  test('XSS attempt in client_name does not execute when /authorize renders', async () => {
    const server = await startServer();
    const redirectUri = 'http://localhost:53682/callback';
    const { challenge } = makePkcePair();
    const meta = await discoverMetadata(server.baseUrl);

    // Register with a hostile client_name.
    const regRes = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: '<script>alert(document.domain)</script>',
        redirect_uris: [redirectUri],
      }),
    });
    const clientId = ((await regRes.json()) as Record<string, unknown>)
      .client_id as string;

    // GET /authorize and verify the script is escaped.
    const authForm = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: '',
      scope: '',
    });
    const formRes = await fetch(
      `${meta.authorization_endpoint}?${authForm}`
    );
    expect(formRes.status).toBe(200);
    const html = await formRes.text();
    expect(html).not.toContain('<script>alert(document.domain)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
