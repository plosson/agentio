import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';
import type { JevAnswer, JevCredentials, JevQuestion, JevResult, JevState, JevUsage } from './types';

/** TypeSafe AI's System One API (https://docs.typesafe.ai/api). */

export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
const REQUEST_TIMEOUT_MS = 60_000;
/** Every command asks one question; this is its id in the request and the answer. */
const QUESTION_ID = 'answer';

export class JevClient implements ServiceClient {
  constructor(private readonly credentials: JevCredentials) {}

  async validate(): Promise<ValidationResult> {
    try {
      await this.ask('Hello there', { type: 'noul', instructions: 'Is this a greeting?' });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** One question about `state`; `model` wins over the profile's. */
  async ask<A extends JevAnswer>(state: JevState, question: JevQuestion, model?: string): Promise<JevResult<A>> {
    const body = { model: model ?? this.credentials.model ?? JEV_DEFAULT_MODEL, state, questions: { [QUESTION_ID]: question } };
    let response: Response;
    try {
      response = await fetch(JEV_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.credentials.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CliError('NETWORK_ERROR', 'Cannot reach Jev at api.typesafe.ai', 'Check your network and retry');
    }
    const text = await response.text().catch(() => '');
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON, such as a proxy's error page: the status alone decides.
    }
    if (!response.ok) throw this.errorFor(response.status, data);

    const envelope = (data ?? {}) as { model?: unknown; answers?: Record<string, unknown>; usage?: unknown };
    const answer = envelope.answers?.[QUESTION_ID] as JevAnswer | undefined;
    if (!answer || answer.type !== question.type) throw new CliError('API_ERROR', 'Jev answered without an answer to the question');
    return {
      model: typeof envelope.model === 'string' ? envelope.model : body.model,
      answer: answer as A,
      usage: (envelope.usage as JevUsage | undefined) ?? null,
    };
  }

  private errorFor(status: number, data: unknown): CliError {
    const detail = this.clean(reason(data));
    switch (status) {
      case 401:
      case 403:
        return new CliError('AUTH_FAILED', 'Jev refused the API key',
          'Create a key at console.typesafe.ai → Settings → Keys, then run: agentio jev profile add');
      case 400:
      case 422:
        return new CliError('INVALID_PARAMS', `Jev refused the question: ${detail ?? 'invalid request'}`);
      case 429:
        return new CliError('RATE_LIMITED', 'Jev\'s rate limit is reached', 'Wait a few seconds and retry');
    }
    return new CliError('API_ERROR', detail ? `Jev error (${status}): ${detail}` : `Jev answered ${status}`);
  }

  /** A server message fit to show: never the API key. */
  private clean(message: string | undefined): string | undefined {
    if (!message) return undefined;
    return message.split(this.credentials.apiKey).join('[api key]');
  }
}

/** The reason in an error body: `error` (text or `{message}`), `message`, or `detail` (text or `[{msg}]`). */
function reason(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const raw = data as { error?: unknown; message?: unknown; detail?: unknown };
  const candidates = [
    raw.error,
    (raw.error as { message?: unknown } | undefined)?.message,
    raw.message,
    raw.detail,
    Array.isArray(raw.detail) ? raw.detail.map((d) => (d as { msg?: unknown })?.msg).filter((m) => typeof m === 'string').join('; ') : undefined,
  ];
  const text = candidates.find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return text?.trim();
}
