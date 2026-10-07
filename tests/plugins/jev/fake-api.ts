/**
 * A stand-in for api.typesafe.ai: replaces globalThis.fetch so a test
 * never leaves the machine, records every request, and answers with what the
 * test queues (status and body as the real API sends them).
 */

import { expect } from 'bun:test';
import { CliError } from '../../../src/utils/errors';

export const KEY = 'ts-test-key-0000';

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

export class FakeJev {
  readonly log: LoggedRequest[] = [];
  private readonly answers: Answer[] = [];
  private readonly original = globalThis.fetch;

  constructor() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
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
