/**
 * A stand-in for auth.openai.com: replaces globalThis.fetch so a test
 * never leaves the machine, records every request, and answers with what the
 * test queues (status and body as the real API sends them).
 */

import { expect } from 'bun:test';
import { CliError } from '../../../src/utils/errors';

/** An unsigned JWT with `claims` as its payload, as far as agentio reads one. */
export function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

/** The CliError a promise rejects with; fails the test when it resolves or throws anything else. */
export async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected a CliError, got success');
}

export interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = { status: number; body?: unknown; raw?: string } | 'network-error';

export class FakeOpenAiAuth {
  readonly log: LoggedRequest[] = [];
  private readonly answers: Answer[] = [];
  private readonly original = globalThis.fetch;

  constructor() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const form = headers['content-type'] === 'application/x-www-form-urlencoded';
      const body = typeof init?.body === 'string'
        ? (form ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body))
        : undefined;
      this.log.push({ method: init?.method ?? 'GET', url, headers, body });
      const answer = this.answers.shift();
      if (!answer) throw new Error(`unexpected request: ${url}`);
      if (answer === 'network-error') throw new TypeError('fetch failed');
      const text = answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body));
      return new Response(text, { status: answer.status });
    }) as typeof fetch;
  }

  /** Queue the answer to the next request. */
  answer(answer: Answer): this {
    this.answers.push(answer);
    return this;
  }

  restore(): void {
    globalThis.fetch = this.original;
  }
}
