import { password } from '@inquirer/prompts';
import { awaitOAuthCode, findAvailablePort, launchBrowser, startOAuthCallbackServer } from '../auth/oauth-server';
import { CliError } from '../utils/errors';
import { interactiveSelect } from '../utils/interactive';
import type { LineReader } from '../utils/line-reader';
import { printJson } from '../utils/output';
import { confirm, prompt } from '../utils/stdin';
import { checkAnswer, parseAnswer } from './setup-inputs';
import type { InputSpec, OAuthSetupOptions, RunContext, SetupContext } from '../plugin-sdk';

const YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

function fail(code: Parameters<SetupContext['fail']>[0], message: string, suggestion?: string): never {
  throw new CliError(code, message, suggestion);
}

/** A failed sign-in as an error with a code, so a program reading --json events can tell what happened. */
async function signIn<T>(port: number, attempt: Promise<T>): Promise<T> {
  try {
    return await attempt;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException)?.code === 'EADDRINUSE' || message.includes('EADDRINUSE')) {
      throw new CliError('CONFIG_ERROR', `Port ${port} is in use, so the sign-in cannot receive its answer`, 'Close the program using it, then try again');
    }
    throw new CliError('AUTH_FAILED', message, 'Run the command again and approve access in the browser');
  }
}

/** Setup in a terminal: questions on stderr, the browser opened here, a pasted address accepted. */
export function createSetupContext(): SetupContext {
  return {
    async ask(spec) {
      let answer: string;
      if (spec.kind === 'choice') {
        answer = await interactiveSelect({
          message: spec.label,
          choices: (spec.choices ?? []).map((choice) => ({ name: choice.label, value: choice.value })),
          default: spec.default,
        });
      } else if (spec.kind === 'secret') {
        answer = await password({ message: spec.label, mask: true });
      } else {
        if (spec.help) console.error(spec.help);
        answer = await prompt(`? ${spec.label}${spec.default ? ` [${spec.default}]` : ''}: `);
      }
      return checkAnswer(spec, !answer.trim() && spec.default !== undefined ? spec.default : answer);
    },
    async prompt(question, options) {
      return options?.secret
        ? password({ message: question, mask: true })
        : prompt(question.endsWith(' ') ? question : `${question} `);
    },
    confirm,
    log: (...parts) => console.error(...parts),
    openUrl: launchBrowser,
    async oauth(options) {
      const port = options.port ?? (await findAvailablePort());
      const redirectUri = `http://localhost:${port}/callback`;
      const result = await signIn(
        port,
        awaitOAuthCode({
          port,
          serviceName: options.serviceName,
          expectedState: options.expectedState,
          authUrl: options.authorizationUrl(redirectUri),
        }),
      );
      return { ...result, redirectUri };
    },
    fail,
    fetch,
  };
}

/**
 * Setup for a program, `profile add --json`: every question is an `ask` event answered by one stdin
 * line, every address to open is an `open` event, and nothing is prompted or opened here.
 * `given` holds the `--input` values, already checked.
 */
export function createJsonSetupContext(given: Record<string, string>, lines: LineReader): SetupContext {
  async function ask(spec: InputSpec): Promise<string> {
    if (Object.hasOwn(given, spec.id)) return given[spec.id];
    printJson({ event: 'ask', ...spec });
    return parseAnswer(await lines.next(), spec);
  }
  return {
    ask,
    prompt: (question, options) => ask({ id: 'prompt', label: question.trim(), kind: options?.secret ? 'secret' : 'text' }),
    confirm: async (question) => (await ask({ id: 'confirm', label: question.trim(), kind: 'choice', choices: YES_NO })) === 'yes',
    log: (...parts) => console.error(...parts),
    openUrl(url) {
      printJson({ event: 'open', url });
      return true;
    },
    async oauth(options: OAuthSetupOptions) {
      const port = options.port ?? (await findAvailablePort());
      const redirectUri = `http://localhost:${port}/callback`;
      // Listen first: the program opens the address as soon as it reads it.
      const callback = startOAuthCallbackServer({ port, serviceName: options.serviceName, expectedState: options.expectedState });
      printJson({ event: 'open', url: options.authorizationUrl(redirectUri) });
      return { ...(await signIn(port, callback)), redirectUri };
    },
    fail,
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
