import { randomUUID } from 'crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  buildProgram,
  executeCommand,
  parseServiceProfiles,
  SERVICE_REGISTRATIONS,
  type ServiceProfilePair,
} from '../mcp/server';
import { collectMcpTools, type McpToolDefinition } from '../mcp/tools';

/**
 * Per-session bookkeeping for the Streamable HTTP MCP transport.
 *
 * The SDK transport is session-oriented: each `WebStandardStreamableHTTPServerTransport`
 * instance has exactly one `sessionId` set during the `initialize` request.
 * That means we need one Server + one Transport pair per active MCP
 * session, not one shared instance for the whole daemon.
 *
 * The session is keyed by the SDK-generated `mcp-session-id` header value.
 * On a new connection (no session id header), we mint a fresh
 * Server+Transport pair, parse the URL's `?services=` to determine which
 * tools to expose, and let the SDK assign a session id during initialize
 * via our `onsessioninitialized` callback.
 *
 * The service set is FROZEN for the session's lifetime — once initialize
 * has run, we ignore any new `?services=` on subsequent requests because
 * Claude Code (and any sane MCP client) won't send them anyway, and
 * letting them mutate the tool surface mid-session would break the
 * client's cached `tools/list`.
 */

interface McpSession {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  services: ServiceProfilePair[];
  toolNames: Set<string>;
  /**
   * Per-session "previously checked" tracking for gchat_list. The plan
   * keys this by `sessionId:service:space`, but since we already have one
   * Map *per session*, the key inside the Map only needs `service:space`.
   */
  lastChecked: Map<string, Date>;
}

const sessions = new Map<string, McpSession>();

/**
 * For tests only — drop all in-memory session state. Tests that exercise
 * the session manager should call this in afterEach so leaked state from
 * one test never bleeds into another.
 */
export function _resetSessionsForTests(): void {
  for (const session of sessions.values()) {
    try {
      session.transport.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}

/* ------------------------------------------------------------------ */
/* services parsing + validation                                       */
/* ------------------------------------------------------------------ */

export interface ParseServicesResult {
  ok: true;
  services: ServiceProfilePair[];
}
export interface ParseServicesError {
  ok: false;
  status: number;
  message: string;
}

/**
 * Parse the `?services=gmail:work,slack:team` query string into
 * ServiceProfilePair[]. Returns a structured result so the caller can
 * decide how to surface failures (HTTP 400, JSON-RPC error, etc.).
 *
 * Empty input → empty array (valid; the session just exposes no tools).
 * Unknown service name → error with the offending service.
 * Empty profile after `:` → error.
 */
export function parseServicesQuery(
  servicesParam: string | null
): ParseServicesResult | ParseServicesError {
  if (!servicesParam) {
    return { ok: true, services: [] };
  }

  const parts = servicesParam
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length === 0) {
    return { ok: true, services: [] };
  }

  // Reject anything with an empty service name (e.g. ":foo" or "foo::bar").
  for (const part of parts) {
    if (part.startsWith(':') || part === ':') {
      return {
        ok: false,
        status: 400,
        message: `invalid services entry "${part}": service name is empty`,
      };
    }
    const colonIdx = part.indexOf(':');
    if (colonIdx !== -1 && colonIdx === part.length - 1) {
      return {
        ok: false,
        status: 400,
        message: `invalid services entry "${part}": profile name is empty after ":"`,
      };
    }
  }

  const pairs = parseServiceProfiles(parts);

  // Validate every service exists in the registry.
  for (const pair of pairs) {
    if (!(pair.service in SERVICE_REGISTRATIONS)) {
      const known = Object.keys(SERVICE_REGISTRATIONS).sort().join(', ');
      return {
        ok: false,
        status: 400,
        message: `unknown service "${pair.service}". known services: ${known}`,
      };
    }
  }

  return { ok: true, services: pairs };
}

/* ------------------------------------------------------------------ */
/* session creation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the Server + Transport pair for a new MCP session, register
 * tool handlers, and connect them. The session is added to the global
 * `sessions` map by the `onsessioninitialized` callback (fired during
 * the first `transport.handleRequest()` call from the initialize
 * request).
 */
async function createSession(
  pairs: ServiceProfilePair[]
): Promise<McpSession> {
  const serviceNames = [...new Set(pairs.map((p) => p.service))];
  const profileMap = new Map<string, string | undefined>();
  for (const pair of pairs) {
    profileMap.set(pair.service, pair.profile);
  }

  // Build the program once to collect the tool list. The same program is
  // NOT reused for executeCommand — we build a fresh one per call to
  // avoid Commander state leaks across invocations.
  const toolProgram = buildProgram(serviceNames);
  const allTools: McpToolDefinition[] = [];
  for (const service of serviceNames) {
    allTools.push(...collectMcpTools(toolProgram, service));
  }
  const toolNames = new Set(allTools.map((t) => t.name));

  const server = new Server(
    { name: 'agentio', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Allocated up front so the closures below + onsessioninitialized can
  // close over the same object.
  const session: McpSession = {
    server,
    // transport is filled in below; the field is non-null after the
    // assignment but TypeScript doesn't know that mid-construction.
    transport: undefined as unknown as WebStandardStreamableHTTPServerTransport,
    services: pairs,
    toolNames,
    lastChecked: new Map(),
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = allTools.find((t) => t.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const service = tool.commandPath[0];
    const profile = profileMap.get(service);
    const input = (args as Record<string, unknown>) || {};

    // Fresh program per call — Commander mutates parser state, and two
    // overlapping calls in the same session would otherwise stomp on
    // each other.
    const execProgram = buildProgram(serviceNames);

    try {
      const output = await executeCommand(execProgram, tool, input, profile);

      let result = output || '(no output)';
      if (name === 'gchat_list' && typeof input.space === 'string') {
        const key = `gchat:${input.space}`;
        const last = session.lastChecked.get(key);
        if (last) {
          result += `\n\nPreviously checked: ${last.toISOString()}`;
        }
        session.lastChecked.set(key, new Date());
      }

      return {
        content: [{ type: 'text' as const, text: result }],
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true, // simpler for hand-rolled HTTP testing
    onsessioninitialized: (sid) => {
      sessions.set(sid, session);
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
    },
  });

  session.transport = transport;
  await server.connect(transport);

  return session;
}

/* ------------------------------------------------------------------ */
/* request entry point                                                 */
/* ------------------------------------------------------------------ */

/**
 * Top-level handler for /mcp requests, called from `http.ts` after the
 * bearer middleware has run.
 *
 * - Existing session id in `mcp-session-id` header → look up the session
 *   and forward to its transport. Unknown id → 404.
 * - No session id → create a new session, validate `?services=`, then
 *   forward to the freshly-built transport. The SDK will assign a
 *   session id during initialize and our `onsessioninitialized` callback
 *   will register it in the map.
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const sessionId = req.headers.get('mcp-session-id');

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: `unknown session id "${sessionId}"`,
          },
          id: null,
        }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    return session.transport.handleRequest(req);
  }

  // No session id — this should be an initialize request. Validate
  // services BEFORE building the session so a typo in ?services= gives
  // a clean 400 instead of an opaque MCP error.
  const url = new URL(req.url);
  const parsed = parseServicesQuery(url.searchParams.get('services'));
  if (!parsed.ok) {
    return new Response(
      JSON.stringify({
        error: 'invalid_request',
        error_description: parsed.message,
      }),
      {
        status: parsed.status,
        headers: { 'content-type': 'application/json' },
      }
    );
  }

  const session = await createSession(parsed.services);
  return session.transport.handleRequest(req);
}

/**
 * Test/diagnostic helper: how many sessions are currently active?
 */
export function _getSessionCount(): number {
  return sessions.size;
}

/**
 * Test helper: peek at the live sessions map. Do not mutate.
 */
export function _peekSessionIds(): string[] {
  return [...sessions.keys()];
}
