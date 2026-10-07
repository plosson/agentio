import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';
import { CLAUDE_CLI, runExternalCli, withTempDir, type CliRun } from '../../utils/external-cli';
import type { AskRequest, AskResult } from '../../utils/llm-ask';
import type { ClaudeCredentials, ClaudeTokenKind } from './types';

/** Replaces Claude Code's own system prompt, which costs thousands of tokens on every call. */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant. Answer the request directly.';

/**
 * Every variable through which claude could pick up a credential other than the profile's, or send it
 * elsewhere than to Anthropic: the cloud-provider switches and the base URL go too.
 */
const CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL',
] as const;
const VARIABLE_FOR: Record<ClaudeTokenKind, string> = { oauth: 'CLAUDE_CODE_OAUTH_TOKEN', apiKey: 'ANTHROPIC_API_KEY' };
const REAUTH = 'Run: agentio claude profile add, with a new token from `claude setup-token` or a new API key';

export function tokenKind(token: string): ClaudeTokenKind {
  if (token.startsWith('sk-ant-oat')) return 'oauth';
  if (token.startsWith('sk-ant-api')) return 'apiKey';
  throw new CliError('INVALID_PARAMS', 'This is not a Claude token or API key',
    'Run `claude setup-token` for a subscription token (sk-ant-oat…), or create an API key (sk-ant-api…) at console.anthropic.com');
}

export class ClaudeClient implements ServiceClient {
  constructor(private readonly credentials: ClaudeCredentials) {}

  /** Setup never runs claude (it may run on a hub without it), so this checks only the shape. */
  async validate(): Promise<ValidationResult> {
    try {
      tokenKind(this.credentials.token);
      return { valid: true, info: this.credentials.kind === 'oauth' ? 'subscription token' : 'API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async ask(request: AskRequest): Promise<AskResult> {
    const model = request.model ?? this.credentials.model;
    const args = [
      '-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--no-session-persistence', '--system-prompt', request.system ?? DEFAULT_SYSTEM_PROMPT,
      ...(model ? ['--model', model] : []),
      ...(request.effort ? ['--effort', request.effort] : []),
    ];
    const run = await withTempDir('agentio-claude-', (cwd) => runExternalCli(CLAUDE_CLI, {
      args,
      input: request.prompt,
      cwd,
      unset: CREDENTIAL_VARIABLES,
      env: { [VARIABLE_FOR[this.credentials.kind]]: this.credentials.token },
    }));
    return parseClaudeResult(run, this.credentials.token);
  }
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: unknown;
  api_error_status?: number | null;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
}

/** What `claude -p --output-format json` printed, as an answer or as the right error. Never shows `secret`. */
export function parseClaudeResult(run: CliRun, secret: string): AskResult {
  const clean = (text: string) => text.split(secret).join('[token]').trim().slice(0, 500);
  let parsed: ClaudeJsonResult | null = null;
  try {
    const value: unknown = JSON.parse(run.stdout.trim());
    if (value && typeof value === 'object') parsed = value as ClaudeJsonResult;
  } catch {
    // Not JSON: decided below.
  }
  if (!parsed) {
    const detail = clean(run.stderr) || clean(run.stdout);
    throw new CliError('API_ERROR', run.exitCode !== 0 && detail ? `Claude Code failed: ${detail}` : 'Claude Code did not answer with JSON');
  }
  if (parsed.is_error || run.exitCode !== 0) {
    const message = clean(typeof parsed.result === 'string' ? parsed.result : run.stderr) || 'unknown error';
    if (parsed.api_error_status === 401 || /invalid api key|oauth token|authenticat|\/login/i.test(message)) {
      throw new CliError('AUTH_FAILED', `Claude refused the profile's credentials: ${message}`, REAUTH);
    }
    if (parsed.api_error_status === 429) throw new CliError('RATE_LIMITED', `Claude's limit is reached: ${message}`, 'Wait and retry');
    throw new CliError('API_ERROR', `Claude Code failed: ${message}`);
  }
  if (typeof parsed.result !== 'string') throw new CliError('API_ERROR', 'Claude Code answered without a result');
  return {
    answer: parsed.result,
    model: Object.keys(parsed.modelUsage ?? {})[0] ?? null,
    usage: parsed.usage ?? null,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : 0,
  };
}
