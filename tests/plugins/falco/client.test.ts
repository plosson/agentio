import { afterEach, describe, expect, test } from 'bun:test';
import { FalcoClient } from '../../../src/plugins/falco/client';
import type { FalcoCredentials } from '../../../src/plugins/falco/types';
import { CliError } from '../../../src/utils/errors';

const credentials: FalcoCredentials = {
  refreshToken: 'refresh',
  refreshExpiryDate: Date.now() + 86_400_000,
  accessToken: 'access',
  expiryDate: Date.now() + 600_000,
  organizationId: 'org-1',
  organizationName: 'Acme BV',
  userId: 'user-1',
  userEmail: 'pierre@example.com',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer each request in turn, recording the URLs the client asked for. */
function stubFetch(responses: Array<Response | (() => Response)>): { urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === 'string' ? input : input.toString());
    const next = responses[Math.min(index++, responses.length - 1)]!;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { urls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('FalcoClient error mapping', () => {
  test('maps 401 to AUTH_FAILED', async () => {
    stubFetch([new Response('nope', { status: 401 })]);
    const error = (await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('AUTH_FAILED');
  });

  test('maps 403 to PERMISSION_DENIED and 404 to NOT_FOUND', async () => {
    stubFetch([new Response('', { status: 403 })]);
    expect(((await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError).code).toBe(
      'PERMISSION_DENIED',
    );

    stubFetch([new Response('', { status: 404 })]);
    expect(((await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError).code).toBe('NOT_FOUND');
  });

  test('maps 429 to RATE_LIMITED', async () => {
    stubFetch([new Response('', { status: 429 })]);
    expect(((await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError).code).toBe('RATE_LIMITED');
  });

  test('reports a transport failure as NETWORK_ERROR, not API_ERROR', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      throw new TypeError('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const error = (await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError;
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('reading the account');
  });

  test('reports malformed JSON as API_ERROR', async () => {
    stubFetch([new Response('<html>maintenance</html>', { status: 200 })]);
    const error = (await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError;
    expect(error.code).toBe('API_ERROR');
  });
});

describe('FalcoClient error shape', () => {
  test('puts the response body in the message, not in the suggestion', async () => {
    // The third CliError argument is an action for the user; other plugins keep
    // response bodies out of it.
    stubFetch([new Response('{"error":"bad_request"}', { status: 400 })]);
    const error = (await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError;

    expect(error.message).toContain('bad_request');
    expect(error.suggestion ?? '').not.toContain('bad_request');
  });

  test('suggests reauth on 401 and suggests nothing on other statuses', async () => {
    stubFetch([new Response('nope', { status: 401 })]);
    expect(((await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError).suggestion).toContain(
      'agentio reauth',
    );

    stubFetch([new Response('nope', { status: 500 })]);
    expect(((await new FalcoClient(credentials).getUserMe().catch((e) => e)) as CliError).suggestion).toBeUndefined();
  });
});

describe('FalcoClient pagination', () => {
  test('walks the cursor and de-duplicates across pages', async () => {
    const { urls } = stubFetch([
      json([{ id: 'a' }, { id: 'b' }]),
      json([{ id: 'b' }, { id: 'c' }]),
      json([]),
    ]);

    const documents = await new FalcoClient(credentials).listAllPeppolDocuments();

    expect(documents.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    // The second page is requested with the last id of the first.
    expect(urls[1]).toContain('last=b');
  });

  test('stops when a page adds nothing, rather than looping on a stuck cursor', async () => {
    const { urls } = stubFetch([json([{ id: 'a' }]), json([{ id: 'a' }])]);

    const documents = await new FalcoClient(credentials).listAllPeppolDocuments();

    expect(documents.map((d) => d.id)).toEqual(['a']);
    expect(urls).toHaveLength(2);
  });

  test('reports progress per page', async () => {
    stubFetch([json([{ id: 'a' }, { id: 'b' }]), json([])]);
    const pages: Array<[number, number, number]> = [];

    await new FalcoClient(credentials).listAllPeppolDocuments({}, (page, added, total) => {
      pages.push([page, added, total]);
    });

    expect(pages).toEqual([[0, 2, 2]]);
  });
});

describe('FalcoClient requests', () => {
  test('scopes Peppol listing to the profile organization', async () => {
    const { urls } = stubFetch([json([])]);
    await new FalcoClient(credentials).listPeppolDocuments();
    expect(urls[0]).toContain('/peppol/documents/org-1');
  });

  test('unwraps the billing envelope', async () => {
    stubFetch([json({ BillingDocuments: [{ Id: 'b-1' }] })]);
    const documents = await new FalcoClient(credentials).listBillingDocuments();
    expect(documents.map((d) => d.Id)).toEqual(['b-1']);
  });

  test('returns an empty list when the billing envelope omits the array', async () => {
    stubFetch([json({})]);
    expect(await new FalcoClient(credentials).listBillingDocuments()).toEqual([]);
  });

  test('validate() reports the account and organization', async () => {
    stubFetch([json({ id: 'u', email: 'pierre@example.com', organizations: [{ id: 'org-1', name: 'Acme BV' }] })]);
    const result = await new FalcoClient(credentials).validate();
    expect(result.valid).toBe(true);
    expect(result.info).toContain('Acme BV');
  });

  test('validate() reports a failure instead of throwing', async () => {
    stubFetch([new Response('', { status: 401 })]);
    const result = await new FalcoClient(credentials).validate();
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
