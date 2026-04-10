import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Subprocess } from 'bun';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { findFreePort, startServerSubprocess } from './test-helpers';

/**
 * End-to-end MCP protocol test.
 *
 * This walks the full stack exactly as a real client (Claude Code,
 * Cursor) would:
 *
 *   1. Start `agentio server start --foreground` in a subprocess with
 *      an isolated HOME.
 *   2. Do the OAuth dance to get a bearer token (DCR → /authorize →
 *      /token).
 *   3. Build the SDK's `StreamableHTTPClientTransport` with the bearer
 *      injected via `requestInit.headers`.
 *   4. Connect an MCP `Client` instance, which triggers
 *      `initialize` + `notifications/initialized` automatically.
 *   5. Call `listTools()` and verify the registered service tools are
 *      present.
 *   6. Call `callTool()` against a fixture RSS feed served by a
 *      temporary local Bun server. Verify the response content.
 */

interface RunningServer {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  apiKey: string;
  port: number;
  baseUrl: string;
}

let tempHome = '';
let active: RunningServer | null = null;
let fixtureServer: ReturnType<typeof Bun.serve> | null = null;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-mcp-e2e-'));
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
  if (fixtureServer) {
    fixtureServer.stop(true);
    fixtureServer = null;
  }
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
    tempHome = '';
  }
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function startAgentioServer(): Promise<RunningServer> {
  const started = await startServerSubprocess({ home: tempHome });
  const running: RunningServer = {
    proc: started.proc,
    apiKey: started.apiKey,
    port: started.port,
    baseUrl: `http://127.0.0.1:${started.port}`,
  };
  active = running;
  return running;
}

/**
 * Walk the OAuth flow with hand-rolled HTTP calls, matching what the
 * oauth-e2e tests already validate. Returns the final bearer token.
 */
async function obtainBearerToken(server: RunningServer): Promise<string> {
  const redirectUri = 'http://localhost:53682/callback';
  const verifier = 'verifier_' + 'a'.repeat(54);
  const challenge = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');

  // Dynamic Client Registration.
  const regRes = await fetch(`${server.baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MCP E2E Test',
      redirect_uris: [redirectUri],
    }),
  });
  if (regRes.status !== 201) {
    throw new Error(`DCR failed: ${regRes.status}`);
  }
  const clientId = ((await regRes.json()) as Record<string, unknown>)
    .client_id as string;

  // Authorize.
  const authRes = await fetch(`${server.baseUrl}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: '',
      scope: 'mcp',
      api_key: server.apiKey,
    }).toString(),
    redirect: 'manual',
  });
  if (authRes.status !== 302) {
    throw new Error(`authorize failed: ${authRes.status}`);
  }
  const code = new URL(authRes.headers.get('location')!).searchParams.get(
    'code'
  )!;

  // Exchange.
  const tokenRes = await fetch(`${server.baseUrl}/token`, {
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
  if (tokenRes.status !== 200) {
    throw new Error(`token failed: ${tokenRes.status}`);
  }
  return ((await tokenRes.json()) as Record<string, unknown>)
    .access_token as string;
}

/**
 * Build an MCP Client connected to the given base URL + services query,
 * using the SDK's StreamableHTTPClientTransport with a bearer token
 * injected via requestInit.headers. Returns the connected client — the
 * caller is responsible for calling `client.close()`.
 */
async function connectMcpClient(
  baseUrl: string,
  services: string,
  bearer: string
): Promise<Client> {
  const url = new URL(
    `${baseUrl}/mcp${services ? `?services=${services}` : ''}`
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { authorization: `Bearer ${bearer}` },
    },
  });
  const client = new Client(
    { name: 'agentio-e2e-test', version: '0.0.1' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

/* ------------------------------------------------------------------ */
/* tests                                                              */
/* ------------------------------------------------------------------ */

describe('MCP end-to-end (real SDK client)', () => {
  test('initialize → listTools exposes rss tools', async () => {
    const server = await startAgentioServer();
    const bearer = await obtainBearerToken(server);
    const client = await connectMcpClient(server.baseUrl, 'rss', bearer);

    try {
      const result = await client.listTools();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
      const names = result.tools.map((t) => t.name);
      expect(names.some((n) => n.startsWith('rss_'))).toBe(true);
    } finally {
      await client.close();
    }
  });

  test('listTools with multiple services exposes tools from each', async () => {
    const server = await startAgentioServer();
    const bearer = await obtainBearerToken(server);
    const client = await connectMcpClient(
      server.baseUrl,
      'rss,sql',
      bearer
    );

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names.some((n) => n.startsWith('rss_'))).toBe(true);
      expect(names.some((n) => n.startsWith('sql_'))).toBe(true);
    } finally {
      await client.close();
    }
  });

  test('listTools with empty services exposes no tools', async () => {
    const server = await startAgentioServer();
    const bearer = await obtainBearerToken(server);
    const client = await connectMcpClient(server.baseUrl, '', bearer);

    try {
      const result = await client.listTools();
      expect(result.tools).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test('callTool: rss_articles against a local fixture feed', async () => {
    const server = await startAgentioServer();
    const bearer = await obtainBearerToken(server);

    // Serve a tiny fixture RSS feed on a free port.
    const fixturePort = await findFreePort();
    fixtureServer = Bun.serve({
      port: fixturePort,
      fetch: () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>E2E Fixture Feed</title>
  <link>http://localhost:${fixturePort}/</link>
  <description>A fixture feed for the mcp-e2e test</description>
  <item>
    <title>First fixture article</title>
    <link>http://localhost:${fixturePort}/article/1</link>
    <guid>http://localhost:${fixturePort}/article/1</guid>
    <description>Content of the first article.</description>
    <pubDate>Thu, 01 Jan 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Second fixture article</title>
    <link>http://localhost:${fixturePort}/article/2</link>
    <guid>http://localhost:${fixturePort}/article/2</guid>
    <description>Content of the second article.</description>
    <pubDate>Fri, 02 Jan 2026 12:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`,
          { headers: { 'content-type': 'application/rss+xml' } }
        ),
    });

    const client = await connectMcpClient(server.baseUrl, 'rss', bearer);
    try {
      const result = await client.callTool({
        name: 'rss_articles',
        arguments: {
          url: `http://127.0.0.1:${fixturePort}/`,
          limit: '5',
        },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
      const joined = content.map((c) => c.text).join('\n');
      expect(joined).toContain('First fixture article');
      expect(joined).toContain('Second fixture article');
    } finally {
      await client.close();
    }
  });

  test('callTool with unknown tool name returns isError', async () => {
    const server = await startAgentioServer();
    const bearer = await obtainBearerToken(server);
    const client = await connectMcpClient(server.baseUrl, 'rss', bearer);

    try {
      const result = await client.callTool({
        name: 'rss_nonexistent_tool_name',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('Unknown tool');
    } finally {
      await client.close();
    }
  });

  test('two concurrent callTool requests in the same session do not cross-contaminate', async () => {
    const server = await startAgentioServer();
    const bearer = await obtainBearerToken(server);

    // Serve two distinct fixture feeds.
    const fixturePort = await findFreePort();
    fixtureServer = Bun.serve({
      port: fixturePort,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/feed-a') {
          return new Response(
            `<?xml version="1.0"?><rss version="2.0"><channel><title>FEED_A_TITLE</title><link>http://x/a</link><description>A</description><item><title>ARTICLE_A_ONE</title><link>http://x/a/1</link><description>a</description></item></channel></rss>`,
            { headers: { 'content-type': 'application/rss+xml' } }
          );
        }
        if (path === '/feed-b') {
          return new Response(
            `<?xml version="1.0"?><rss version="2.0"><channel><title>FEED_B_TITLE</title><link>http://x/b</link><description>B</description><item><title>ARTICLE_B_ONE</title><link>http://x/b/1</link><description>b</description></item></channel></rss>`,
            { headers: { 'content-type': 'application/rss+xml' } }
          );
        }
        return new Response('not found', { status: 404 });
      },
    });

    const client = await connectMcpClient(server.baseUrl, 'rss', bearer);
    try {
      const [a, b] = await Promise.all([
        client.callTool({
          name: 'rss_articles',
          arguments: {
            url: `http://127.0.0.1:${fixturePort}/feed-a`,
            limit: '5',
          },
        }),
        client.callTool({
          name: 'rss_articles',
          arguments: {
            url: `http://127.0.0.1:${fixturePort}/feed-b`,
            limit: '5',
          },
        }),
      ]);

      const textA = (a.content as Array<{ text: string }>)
        .map((c) => c.text)
        .join('\n');
      const textB = (b.content as Array<{ text: string }>)
        .map((c) => c.text)
        .join('\n');

      expect(textA).toContain('ARTICLE_A_ONE');
      expect(textA).not.toContain('ARTICLE_B_ONE');
      expect(textB).toContain('ARTICLE_B_ONE');
      expect(textB).not.toContain('ARTICLE_A_ONE');
    } finally {
      await client.close();
    }
  });

  test('a second client on the same server gets an independent session', async () => {
    const server = await startAgentioServer();
    const bearer = await obtainBearerToken(server);

    const clientA = await connectMcpClient(server.baseUrl, 'rss', bearer);
    const clientB = await connectMcpClient(server.baseUrl, 'sql', bearer);

    try {
      const [a, b] = await Promise.all([
        clientA.listTools(),
        clientB.listTools(),
      ]);
      // clientA asked for rss → should see rss tools but NOT sql.
      expect(a.tools.every((t) => t.name.startsWith('rss_'))).toBe(true);
      // clientB asked for sql → sql tools only.
      expect(b.tools.every((t) => t.name.startsWith('sql_'))).toBe(true);
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });
});
