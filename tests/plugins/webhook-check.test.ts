import { describe, expect, test } from 'bun:test';
import { fakeSetupContext } from '../helpers/setup-context';
import { checkWebhookUrl, type WebhookCheck } from '../../src/plugins/webhook-check';
import { CliError } from '../../src/utils/errors';

const HOOK = 'https://hooks.example.com/services/SECRET-HOOK-TOKEN';
const CHECK: WebhookCheck = {
  prefix: 'https://hooks.example.com/',
  invalidMessage: 'Not an Example webhook URL',
  invalidSuggestion: 'It starts with https://hooks.example.com/',
};

function contextAnswering(answer: (url: string, init?: RequestInit) => Promise<Response>) {
  const context = fakeSetupContext({});
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  context.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return answer(url, init);
  }) as never;
  return { context, calls };
}

async function failure(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    return error as CliError;
  }
  throw new Error('expected a failure');
}

describe('checkWebhookUrl', () => {
  test('a URL without the prefix, or a lookalike host, is refused with the given texts and nothing is fetched', async () => {
    for (const url of ['https://evil.example.com/x', 'https://hooks.example.com.evil.example/x', 'http://hooks.example.com/x', '']) {
      const { context, calls } = contextAnswering(async () => new Response('', { status: 200 }));
      const error = await failure(() => checkWebhookUrl(url, CHECK, context));
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: 'INVALID_PARAMS', message: 'Not an Example webhook URL', suggestion: 'It starts with https://hooks.example.com/' });
      expect(calls).toEqual([]);
    }
  });

  test('a network failure is an API_ERROR that quotes neither the error text nor the URL', async () => {
    const { context } = contextAnswering(async (url) => { throw new TypeError(`connect ECONNREFUSED ${url}`); });
    const error = await failure(() => checkWebhookUrl(HOOK, CHECK, context));
    expect(error).toMatchObject({ code: 'API_ERROR', message: 'Failed to validate webhook', suggestion: 'Check that the URL is correct and accessible' });
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(error.message).not.toContain('SECRET-HOOK-TOKEN');
  });

  test('a non-Error rejection is an API_ERROR too', async () => {
    const { context } = contextAnswering(async () => { throw 'boom'; });
    const error = await failure(() => checkWebhookUrl(HOOK, CHECK, context));
    expect(error).toMatchObject({ code: 'API_ERROR', message: 'Failed to validate webhook' });
  });

  test('a refused test POST is an API_ERROR with the status; the answer body only when asked for', async () => {
    const { context } = contextAnswering(async () => new Response('no_service', { status: 404 }));
    expect(await failure(() => checkWebhookUrl(HOOK, CHECK, context)))
      .toMatchObject({ code: 'API_ERROR', message: 'Webhook validation failed: 404', suggestion: 'Check the webhook URL and try again' });
    expect(await failure(() => checkWebhookUrl(HOOK, { ...CHECK, showResponseBody: true }, context)))
      .toMatchObject({ code: 'API_ERROR', message: 'Webhook validation failed: 404 no_service' });
  });

  test('an accepted test POST: one JSON POST to the URL itself', async () => {
    const { context, calls } = contextAnswering(async () => new Response('ok', { status: 200 }));
    await checkWebhookUrl(HOOK, CHECK, context);
    expect(calls).toEqual([{ url: HOOK, method: 'POST', body: JSON.stringify({ text: 'Test message from agentio' }) }]);
  });
});
