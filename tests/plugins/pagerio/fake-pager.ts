/**
 * A stand-in for a Pocket Pager server: replaces globalThis.fetch so a test
 * never leaves the machine, records every request with its raw body (the URL
 * check deliberately sends invalid JSON), and answers with what the test queues.
 */

import { expect } from 'bun:test';
import { CliError } from '../../../src/utils/errors';

export const TOKEN = 'AbCdEfGh12345678';
export const PAGER_URL = `https://pagerio.chuut.com/p/${TOKEN}`;

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
  body: string | undefined;
}

type Answer = { status: number; body?: unknown; raw?: string } | 'network-error';

export class FakePager {
  readonly log: LoggedRequest[] = [];
  private readonly answers: Answer[] = [];
  private readonly original = globalThis.fetch;

  constructor() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = typeof init?.body === 'string' ? init.body : undefined;
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

/** The server's error body. */
export function serverError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
