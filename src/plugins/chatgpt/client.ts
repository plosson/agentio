import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError, redact } from '../../utils/errors';
import { CODEX_CLI, runExternalCli, withTempDir } from '../../utils/external-cli';
import type { AskRequest, AskResult } from '../../utils/llm-ask';
import { REAUTH } from './oauth';
import type { ChatGptCredentials } from './types';

/**
 * Every variable through which codex could pick up another credential, or send the profile's elsewhere
 * than to OpenAI: the base URLs and endpoint overrides it reads (found in codex-cli's binary) go too.
 */
const CREDENTIAL_VARIABLES = [
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME',
  'OPENAI_BASE_URL', 'CODEX_AUTHAPI_BASE_URL', 'CODEX_APP_SERVER_CHATGPT_BASE_URL', 'CODEX_CLOUD_TASKS_BASE_URL',
  'CODEX_OSS_BASE_URL', 'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL', 'CODEX_AGENT_IDENTITY_JWKS_BASE_URL',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
] as const;

/**
 * codex's auth.json for a sign-in: the access token only. With no refresh token, codex cannot
 * rotate the chain the vault holds; `last_refresh` now stops it from trying.
 */
export function codexAuthJson(credentials: ChatGptCredentials): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: credentials.idToken ?? '', access_token: credentials.accessToken, refresh_token: '', account_id: credentials.accountId ?? '' },
    last_refresh: new Date().toISOString(),
  });
}

/** `codex exec --json` events: the turn's usage, and the first error message. */
export function parseCodexEvents(stdout: string): { usage: Record<string, unknown> | null; error: string | null } {
  let usage: Record<string, unknown> | null = null;
  let error: string | null = null;
  for (const line of stdout.split('\n')) {
    let event: { type?: string; usage?: Record<string, unknown>; message?: unknown; error?: { message?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'turn.completed' && event.usage) usage = event.usage;
    const message = event.type === 'error' ? event.message : event.type === 'turn.failed' ? event.error?.message : undefined;
    if (typeof message === 'string' && !error) error = message;
  }
  return { usage, error };
}

export class ChatGptClient implements ServiceClient {
  constructor(private readonly credentials: ChatGptCredentials) {}

  async validate(): Promise<ValidationResult> {
    const c = this.credentials;
    try {
      this.assertUsable();
    } catch {
      return { valid: false, error: 'No usable credential' };
    }
    return { valid: true, info: c.kind === 'apiKey' ? 'API key' : c.email ?? 'ChatGPT sign-in' };
  }

  /** Throws unless the profile holds the token or key its kind needs. */
  private assertUsable(): void {
    const c = this.credentials;
    if (c.kind === 'chatgpt' && !c.accessToken) throw new CliError('AUTH_FAILED', 'This ChatGPT profile has no access token', REAUTH);
    if (c.kind === 'apiKey' && !c.apiKey) throw new CliError('AUTH_FAILED', 'This ChatGPT profile has no API key', 'Run: agentio chatgpt profile add');
  }

  async ask(request: AskRequest): Promise<AskResult> {
    const c = this.credentials;
    this.assertUsable();
    const model = request.model ?? c.model;
    const secrets = [c.accessToken, c.apiKey, c.idToken].filter((s): s is string => !!s);
    const clean = (text: string) => redact(text, secrets, '[token]').trim().slice(0, 500);
    const started = Date.now();

    return withTempDir('agentio-codex-home-', (codexHome) => withTempDir('agentio-codex-', async (cwd) => {
      if (c.kind === 'chatgpt') await writeFile(join(codexHome, 'auth.json'), codexAuthJson(c), { mode: 0o600 });
      const answerPath = join(codexHome, 'answer.txt');
      const args = [
        'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only', '--json', '-o', answerPath,
        ...(model ? ['-m', model] : []),
        // -c values are TOML; a JSON string is a valid TOML basic string.
        ...(request.system ? ['-c', `developer_instructions=${JSON.stringify(request.system)}`] : []),
        ...(request.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(request.effort)}`] : []),
        '-',
      ];
      const run = await runExternalCli(CODEX_CLI, {
        args,
        input: request.prompt,
        cwd,
        unset: CREDENTIAL_VARIABLES,
        env: { CODEX_HOME: codexHome, ...(c.kind === 'apiKey' ? { CODEX_API_KEY: c.apiKey! } : {}) },
      });
      const { usage, error } = parseCodexEvents(run.stdout);
      if (run.exitCode !== 0 || error) {
        const message = clean(error ?? run.stderr) || `exit code ${run.exitCode}`;
        if (/\b401\b|unauthorized|token.*(expired|invalid)/i.test(message)) {
          throw new CliError('AUTH_EXPIRED', `OpenAI refused the profile's credentials: ${message}`, c.kind === 'apiKey' ? 'Run: agentio chatgpt profile add' : REAUTH);
        }
        if (/\b429\b|rate limit|usage limit/i.test(message)) throw new CliError('RATE_LIMITED', `ChatGPT's limit is reached: ${message}`, 'Wait and retry');
        throw new CliError('API_ERROR', `Codex failed: ${message}`);
      }
      const answer = await readFile(answerPath, 'utf8').catch(() => '');
      if (!answer.trim()) throw new CliError('API_ERROR', 'Codex finished without an answer');
      return { answer, model: model ?? null, usage, costUsd: null, durationMs: Date.now() - started };
    }));
  }
}
