/**
 * Setup page served at `/` — lets an operator (who holds the API key) pick
 * services/profiles and generate the MCP URL + `claude mcp add` snippet.
 *
 * Auth model: a small login form asks for the API key, then we set an
 * HttpOnly cookie whose value is HMAC(apiKey, magic). Every request
 * re-derives that HMAC and compares. If the key rotates, old cookies
 * stop validating — no session store needed.
 */

import { createHmac } from 'crypto';

import { listProfiles } from '../config/config-manager';
import type { ServerContext } from './http';
import { constantTimeEquals, getRequestOrigin } from './oauth';

const COOKIE_NAME = 'agentio_setup';
const COOKIE_MAGIC = 'agentio-setup-v1';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12; // 12h

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function signApiKey(apiKey: string): string {
  return createHmac('sha256', apiKey).update(COOKIE_MAGIC).digest('base64url');
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(rest.join('='));
    } catch {
      out[name] = rest.join('=');
    }
  }
  return out;
}

function isAuthenticated(req: Request, ctx: ServerContext): boolean {
  const cookies = parseCookies(req.headers.get('cookie'));
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  return constantTimeEquals(token, signApiKey(ctx.apiKey));
}

function isHttps(req: Request): boolean {
  const forwarded = req.headers.get('forwarded');
  if (forwarded && /proto=https/i.test(forwarded)) return true;
  const xfp = req.headers.get('x-forwarded-proto');
  if (xfp && xfp.toLowerCase() === 'https') return true;
  return new URL(req.url).protocol === 'https:';
}

function buildCookieHeader(value: string, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

const BASE_CSS = `
:root { color-scheme: light dark; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  max-width: 640px;
  margin: 6vh auto;
  padding: 0 24px;
  line-height: 1.5;
}
h1 { font-size: 1.4rem; margin-bottom: 0.4rem; }
h2 {
  font-size: 0.85rem;
  margin: 0 0 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #666;
}
.meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
.meta code { font-size: 0.85rem; }
form { display: flex; flex-direction: column; gap: 0.75rem; }
label { font-weight: 600; }
input[type=password], input[type=text], textarea {
  padding: 0.6rem 0.75rem;
  font-size: 0.95rem;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  border: 1px solid #888;
  border-radius: 6px;
  width: 100%;
  box-sizing: border-box;
  background: transparent;
  color: inherit;
}
textarea { resize: vertical; }
button {
  padding: 0.6rem 1rem;
  font-size: 1rem;
  font-weight: 600;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
button:hover { background: #1d4ed8; }
.error {
  background: #fee;
  color: #900;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  border: 1px solid #fcc;
  margin: 0;
}
`;

const PROFILES_CSS = `
.services { display: flex; flex-direction: column; gap: 0.8rem; }
section.service {
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 0.6rem 0.9rem;
}
label.profile {
  display: block;
  font-weight: normal;
  padding: 0.15rem 0;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 0.9rem;
  cursor: pointer;
}
label.profile input { margin-right: 0.5rem; }
.output { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 1.4rem; }
.output label { font-weight: 600; font-size: 0.9rem; }
.output .row { display: flex; gap: 0.5rem; }
.output .row input, .output .row textarea { flex: 1; }
.output button {
  align-self: flex-start;
  font-size: 0.85rem;
  padding: 0.5rem 0.9rem;
}
@media (prefers-color-scheme: dark) {
  section.service { border-color: #444; }
  input[type=password], input[type=text], textarea { border-color: #555; }
}
`;

function loginFormHtml(errorMessage?: string): string {
  const errorBlock = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agentio MCP setup</title>
<style>${BASE_CSS}</style>
</head>
<body>
<h1>agentio MCP setup</h1>
<p class="meta">Enter your agentio API key to continue.</p>
${errorBlock}
<form method="post" action="/">
  <label for="api_key">agentio API key</label>
  <input id="api_key" name="api_key" type="password" autocomplete="off" autofocus required>
  <button type="submit">Continue</button>
</form>
</body>
</html>`;
}

interface ServiceProfileList {
  service: string;
  profiles: string[];
}

function profilesPageHtml(origin: string, configured: ServiceProfileList[]): string {
  const dataJson = JSON.stringify({ origin }).replace(/</g, '\\u003c');

  const sectionsHtml = configured
    .map((s) => {
      const items = s.profiles
        .map((p) => {
          const value = `${s.service}:${p}`;
          return `    <label class="profile"><input type="checkbox" name="sp" value="${escapeHtml(
            value
          )}"> ${escapeHtml(p)}</label>`;
        })
        .join('\n');
      return `  <section class="service">
    <h2>${escapeHtml(s.service)}</h2>
${items}
  </section>`;
    })
    .join('\n');

  const emptyMessage =
    configured.length === 0
      ? `<p class="meta">No profiles configured yet. Add some with <code>agentio &lt;service&gt; profile add</code> in the CLI that owns this server.</p>`
      : '';

  const body =
    configured.length === 0
      ? emptyMessage
      : `<div class="services">
${sectionsHtml}
</div>
<div class="output">
  <label for="url">MCP URL</label>
  <div class="row"><input id="url" type="text" readonly></div>
  <button id="copy-url" type="button">Copy URL</button>
</div>
<div class="output">
  <label for="snippet">Claude Code command</label>
  <div class="row"><textarea id="snippet" readonly rows="2"></textarea></div>
  <button id="copy-snippet" type="button">Copy command</button>
</div>`;

  const script =
    configured.length === 0
      ? ''
      : `<script id="page-data" type="application/json">${dataJson}</script>
<script>
(function() {
  const data = JSON.parse(document.getElementById('page-data').textContent);
  const urlEl = document.getElementById('url');
  const snipEl = document.getElementById('snippet');
  const boxes = document.querySelectorAll('input[type=checkbox][name=sp]');

  function recompute() {
    const selected = Array.from(boxes).filter(b => b.checked).map(b => b.value);
    const base = data.origin + '/mcp';
    const url = selected.length
      ? base + '?services=' + encodeURIComponent(selected.join(','))
      : base;
    urlEl.value = url;
    snipEl.value = 'claude mcp add --scope local --transport http agentio "' + url + '"';
  }

  boxes.forEach(b => b.addEventListener('change', recompute));
  recompute();

  function wireCopy(btnId, targetId) {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', async () => {
      const target = document.getElementById(targetId);
      try {
        await navigator.clipboard.writeText(target.value);
      } catch {
        target.select();
        document.execCommand && document.execCommand('copy');
      }
      const old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = old; }, 1200);
    });
  }
  wireCopy('copy-url', 'url');
  wireCopy('copy-snippet', 'snippet');
})();
</script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agentio MCP setup</title>
<style>${BASE_CSS}${PROFILES_CSS}</style>
</head>
<body>
<h1>agentio MCP setup</h1>
<p class="meta">Tick the profiles to expose, then copy the MCP URL or the <code>claude mcp add</code> command.</p>
${body}
${script}
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleSetupGet(
  req: Request,
  ctx: ServerContext
): Promise<Response> {
  if (!isAuthenticated(req, ctx)) {
    return new Response(loginFormHtml(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const origin = getRequestOrigin(req);
  const all = await listProfiles();
  const configured: ServiceProfileList[] = all
    .filter((s) => s.profiles.length > 0)
    .map((s) => ({
      service: s.service,
      profiles: s.profiles.map((p) => p.name),
    }));

  return new Response(profilesPageHtml(origin, configured), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function handleSetupPost(
  req: Request,
  ctx: ServerContext
): Promise<Response> {
  let form: URLSearchParams;
  try {
    const body = await req.text();
    form = new URLSearchParams(body);
  } catch {
    return new Response(loginFormHtml('Could not read form body.'), {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const apiKey = form.get('api_key') ?? '';
  if (!apiKey || !constantTimeEquals(apiKey, ctx.apiKey)) {
    return new Response(loginFormHtml('Invalid API key.'), {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const cookie = buildCookieHeader(signApiKey(ctx.apiKey), isHttps(req));
  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': cookie },
  });
}

export async function routeSetup(
  req: Request,
  ctx: ServerContext
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== '/') return null;
  if (req.method === 'GET') return handleSetupGet(req, ctx);
  if (req.method === 'POST') return handleSetupPost(req, ctx);
  return null;
}
