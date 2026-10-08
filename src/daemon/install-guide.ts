import { isSecureRequest } from './session';

// Nothing here comes from ui/model.ts: assets.ts embeds that file as text, and
// bun build --compile cannot load one file both as text and as code.

/** Installs agentio on macOS or Linux; this guide and the page's Connect card (through assets.ts) both show it. */
export const INSTALL_COMMAND = 'curl -LsSf https://agentio.houlahop.com/install | sh';

/**
 * Host names, with an optional port. No IPv6 literal: its brackets would need shell quoting,
 * and without any, the guide's `agentio login` line is the page's loginCommand word for word.
 */
const HOST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/;

/**
 * The hub's address as the person reached it: the TLS proxy's forwarded protocol, and the host
 * the request names. Null when the host is not a plain host name.
 */
export function requestOrigin(request: Request): string | null {
  const { host } = new URL(request.url);
  if (!HOST.test(host)) return null;
  return `${isSecureRequest(request) ? 'https' : 'http'}://${host}`;
}

/** What an agent reads to connect its machine to this hub: install agentio, sign in, then learn the commands. */
export function installGuide(origin: string): string {
  return `# Connect this machine to an agentio vault

You are setting up **agentio** for the user, so you can use the profiles in
their vault at ${origin}. Their passwords and keys stay in the vault; you only
get the access they approve.

## 1. Install agentio

Skip this step if \`agentio --version\` already works.

On macOS or Linux:

    ${INSTALL_COMMAND}

On Windows (PowerShell):

    iwr -useb https://agentio.houlahop.com/install.ps1 | iex

## 2. Connect to the vault

    agentio login ${origin}

The command prints a code and waits. **Tell the user the code** and ask them to
approve it in their vault: the request shows on its Overview page. Do not
continue before it is approved.

## 3. See what you may use

    agentio status

It lists the profiles you may use. For the commands of one service:

    agentio skill <service>        # for example: agentio skill gmail
`;
}

/** GET /install.md: public, like /health; it holds no secret, only the hub's own address. */
export function handleInstallGuide(request: Request): Response {
  const origin = requestOrigin(request);
  if (!origin) return new Response('Bad host\n', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(installGuide(origin), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
