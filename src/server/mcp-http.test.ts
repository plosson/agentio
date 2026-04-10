import { afterEach, describe, expect, test } from 'bun:test';

import {
  _getSessionCount,
  _resetSessionsForTests,
  handleMcpRequest,
  parseServicesQuery,
} from './mcp-http';

/**
 * Pure-ish unit tests for the session manager. `parseServicesQuery` is
 * a pure function — tested exhaustively. `handleMcpRequest` touches the
 * module-level `sessions` map, so tests wipe it in afterEach.
 */

afterEach(() => {
  _resetSessionsForTests();
});

/* ------------------------------------------------------------------ */
/* parseServicesQuery                                                  */
/* ------------------------------------------------------------------ */

describe('parseServicesQuery — happy path', () => {
  test('null → empty services (valid)', () => {
    const r = parseServicesQuery(null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.services).toEqual([]);
  });

  test('empty string → empty services', () => {
    const r = parseServicesQuery('');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.services).toEqual([]);
  });

  test('whitespace-only → empty services', () => {
    const r = parseServicesQuery('   ,  , ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.services).toEqual([]);
  });

  test('single service without profile', () => {
    const r = parseServicesQuery('rss');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.services).toEqual([{ service: 'rss', profile: undefined }]);
  });

  test('single service:profile pair', () => {
    const r = parseServicesQuery('gchat:default');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.services).toEqual([{ service: 'gchat', profile: 'default' }]);
  });

  test('multiple services with mixed profile/no-profile', () => {
    const r = parseServicesQuery('rss,gchat:default,gmail:work');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.services).toEqual([
        { service: 'rss', profile: undefined },
        { service: 'gchat', profile: 'default' },
        { service: 'gmail', profile: 'work' },
      ]);
  });

  test('trims whitespace around each entry', () => {
    const r = parseServicesQuery('  rss , gchat:default  ');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.services).toEqual([
        { service: 'rss', profile: undefined },
        { service: 'gchat', profile: 'default' },
      ]);
  });

  test('accepts all valid registered services', () => {
    const all =
      'discourse,gcal,gchat,gdocs,gdrive,github,gmail,gsheets,gtasks,jira,rss,slack,sql,telegram,whatsapp';
    const r = parseServicesQuery(all);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.services.length).toBe(15);
  });
});

describe('parseServicesQuery — adversarial', () => {
  test('unknown service name → 400 with known-services hint', () => {
    const r = parseServicesQuery('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.message).toContain('unknown service');
      expect(r.message).toContain('"nope"');
      expect(r.message).toContain('rss'); // sample of known services
    }
  });

  test('one unknown among valid → still rejected', () => {
    const r = parseServicesQuery('rss,nope,gmail:x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('nope');
  });

  test('service name with empty profile (trailing colon) → 400', () => {
    const r = parseServicesQuery('gmail:');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.message).toContain('profile name is empty');
    }
  });

  test('leading colon (empty service name) → 400', () => {
    const r = parseServicesQuery(':foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('service name is empty');
  });

  test('bare colon → 400', () => {
    const r = parseServicesQuery(':');
    expect(r.ok).toBe(false);
  });

  test('case-sensitive: RSS (uppercase) → unknown', () => {
    const r = parseServicesQuery('RSS');
    expect(r.ok).toBe(false);
  });

  test('service name with unexpected characters → unknown', () => {
    const r = parseServicesQuery('rss-feed');
    expect(r.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* handleMcpRequest — routing (no real MCP protocol yet)               */
/* ------------------------------------------------------------------ */

describe('handleMcpRequest — routing', () => {
  test('unknown mcp-session-id → 404 JSON-RPC error', async () => {
    const req = new Request('http://localhost:9999/mcp', {
      method: 'POST',
      headers: {
        'mcp-session-id': 'does-not-exist',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    const res = await handleMcpRequest(req);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.jsonrpc).toBe('2.0');
    const error = body.error as Record<string, unknown>;
    expect(error.message).toContain('does-not-exist');
  });

  test('no session id + invalid services → 400 BEFORE transport runs', async () => {
    const req = new Request(
      'http://localhost:9999/mcp?services=nope',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        }),
      }
    );
    const res = await handleMcpRequest(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('unknown service');
    // And no session was leaked into the map.
    expect(_getSessionCount()).toBe(0);
  });

  test('no session id + empty services → transport runs, session created on initialize', async () => {
    const req = new Request('http://localhost:9999/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      }),
    });
    const res = await handleMcpRequest(req);
    // The SDK accepts the initialize and assigns a session id.
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeDefined();
    expect(_getSessionCount()).toBe(1);
  });

  test('session survives across multiple requests routed by mcp-session-id', async () => {
    // First: initialize (creates session).
    const initReq = new Request('http://localhost:9999/mcp?services=rss', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      }),
    });
    const initRes = await handleMcpRequest(initReq);
    const sid = initRes.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    // Drain the body so the stream doesn't leak.
    await initRes.text();

    // Per MCP spec: client sends notifications/initialized after the
    // initialize response before using other methods.
    const notifReq = new Request('http://localhost:9999/mcp?services=rss', {
      method: 'POST',
      headers: {
        'mcp-session-id': sid!,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    const notifRes = await handleMcpRequest(notifReq);
    expect(notifRes.status).toBeLessThan(500);
    await notifRes.text();

    // Second request: tools/list against the same session.
    const listReq = new Request('http://localhost:9999/mcp?services=rss', {
      method: 'POST',
      headers: {
        'mcp-session-id': sid!,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });
    const listRes = await handleMcpRequest(listReq);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as Record<string, unknown>;
    expect(listBody.jsonrpc).toBe('2.0');
    const result = listBody.result as Record<string, unknown>;
    expect(Array.isArray(result.tools)).toBe(true);
    // rss has at least one tool (rss_articles).
    const tools = result.tools as Array<{ name: string }>;
    expect(tools.some((t) => t.name.startsWith('rss_'))).toBe(true);
  });

  test('DELETE on a live session removes it from the map', async () => {
    // Create a session first.
    const init = await handleMcpRequest(
      new Request('http://localhost:9999/mcp?services=rss', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        }),
      })
    );
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();
    expect(_getSessionCount()).toBe(1);

    const del = await handleMcpRequest(
      new Request('http://localhost:9999/mcp', {
        method: 'DELETE',
        headers: {
          'mcp-session-id': sid,
          'mcp-protocol-version': '2024-11-05',
        },
      })
    );
    // DELETE is handled by the transport; either 200 or 204 is fine.
    expect([200, 204]).toContain(del.status);
    expect(_getSessionCount()).toBe(0);
  });

  test('two concurrent initialize requests create two independent sessions', async () => {
    const mkInitReq = () =>
      new Request('http://localhost:9999/mcp?services=rss', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        }),
      });

    const [a, b] = await Promise.all([
      handleMcpRequest(mkInitReq()),
      handleMcpRequest(mkInitReq()),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const sidA = a.headers.get('mcp-session-id');
    const sidB = b.headers.get('mcp-session-id');
    expect(sidA).toBeTruthy();
    expect(sidB).toBeTruthy();
    expect(sidA).not.toBe(sidB);
    expect(_getSessionCount()).toBe(2);
    await a.text();
    await b.text();
  });
});
