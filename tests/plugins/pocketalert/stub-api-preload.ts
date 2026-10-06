// Preloaded into a CLI subprocess (BUN_OPTIONS=--preload): api.pocketalert.app is answered here, so a
// test never leaves the machine. The key `good-key` has one application; any other key is refused.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.pocketalert.app/')) throw new TypeError(`blocked: ${url}`);
  const token = new Headers(init?.headers).get('token');
  if (token !== process.env.STUB_POCKETALERT_KEY) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 });
  return new Response(JSON.stringify([{ tid: 'a1', name: 'agentio' }]), { status: 200 });
}) as typeof fetch;
