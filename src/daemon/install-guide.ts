import { isSecureRequest } from './session';
import { INSTALL_COMMAND, loginCommand } from './ui/model';

/** Host names and IPv6 literals, with an optional port: nothing that could break out of the guide's commands. */
const HOST = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

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

    ${loginCommand(origin)}

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
