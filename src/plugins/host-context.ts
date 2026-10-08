import { password } from '@inquirer/prompts';
import { DEFAULT_CALLBACK_PATH, awaitOAuthCode, findAvailablePort, launchBrowser } from '../auth/oauth-server';
import { CliError } from '../utils/errors';
import { interactiveSelect } from '../utils/interactive';
import { confirm, prompt } from '../utils/stdin';
import { checkAnswer } from './setup-inputs';
import type { OAuthSetupOptions, RunContext, SetupContext } from '../plugin-sdk';

function fail(code: Parameters<SetupContext['fail']>[0], message: string, suggestion?: string): never {
  throw new CliError(code, message, suggestion);
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
      // The provider's fixed port, or a free one; a busy port fails with CONFIG_ERROR before anything is opened.
      const port = options.port ?? (await findAvailablePort(options.host));
      const redirectUri = `http://${options.host ?? 'localhost'}:${port}${options.path ?? DEFAULT_CALLBACK_PATH}`;
      const result = await awaitOAuthCode({
        port,
        host: options.host,
        path: options.path,
        serviceName: options.serviceName,
        expectedState: options.expectedState,
        authUrl: options.authorizationUrl(redirectUri),
      });
      return { ...result, redirectUri };
    },
    async runInTerminal(command) {
      const proc = Bun.spawn([...command], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env });
      return await proc.exited;
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
