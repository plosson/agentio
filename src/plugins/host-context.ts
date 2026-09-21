import { password } from '@inquirer/prompts';
import { awaitOAuthCode, findAvailablePort, launchBrowser } from '../auth/oauth-server';
import { CliError } from '../utils/errors';
import { confirm, prompt } from '../utils/stdin';
import type { RunContext, SetupContext } from '../plugin-sdk';

export function createSetupContext(): SetupContext {
  return {
    async prompt(question, options) {
      return options?.secret
        ? password({ message: question, mask: true })
        : prompt(question.endsWith(' ') ? question : `${question} `);
    },
    confirm,
    log: (...parts) => console.error(...parts),
    openUrl: launchBrowser,
    async oauth(options) {
      const port = await findAvailablePort();
      const redirectUri = `http://localhost:${port}/callback`;
      const result = await awaitOAuthCode({
        port,
        serviceName: options.serviceName,
        expectedState: options.expectedState,
        authUrl: options.authorizationUrl(redirectUri),
      });
      return { ...result, redirectUri };
    },
    fail(code, message, suggestion): never {
      throw new CliError(code, message, suggestion);
    },
    fetch,
  };
}

export function createRunContext<Credentials extends object>(
  credentials: Credentials,
  profile: string,
  signal: AbortSignal = new AbortController().signal,
): RunContext<Credentials> {
  return {
    credentials,
    profile,
    signal,
    fetch,
    log: (...parts) => console.error(...parts),
    fail(code, message, suggestion): never {
      throw new CliError(code, message, suggestion);
    },
  };
}
