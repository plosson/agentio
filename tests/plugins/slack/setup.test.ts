import { describe, expect, test } from 'bun:test';
import { fakeSetupContext } from '../../helpers/setup-context';
import { slackProfileAdd } from '../../../src/plugins/slack/commands';
import { CliError } from '../../../src/utils/errors';

const HOOK = 'https://hooks.slack.com/services/T000/B000/SECRET-HOOK-TOKEN';

/** A setup context whose fetch records its calls and answers with `status`. */
function contextWith(answers: Record<string, string>, status = 200) {
  const context = fakeSetupContext(answers);
  const calls: { url: string; method?: string }[] = [];
  context.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return new Response('nope', { status });
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

describe('slackProfileAdd', () => {
  test('a URL on another host is refused, never echoed, and fetch is never called', async () => {
    const { context, calls } = contextWith({ 'Webhook URL': 'https://evil.example.com/SECRET-PATH' });
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toBe('Invalid Slack webhook URL');
    expect(error.suggestion ?? '').not.toContain('SECRET-PATH');
    expect(calls).toEqual([]);
    expect(context.asked.map((s) => s.label)).toEqual(['Webhook URL']);
  });

  test('a lookalike host is refused', async () => {
    const { context, calls } = contextWith({ 'Webhook URL': 'https://hooks.slack.com.evil.example/x' });
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(calls).toEqual([]);
  });

  test('an empty webhook URL is refused before any request', async () => {
    const { context, calls } = contextWith({ 'Webhook URL': '   ' });
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(calls).toEqual([]);
  });

  test('a test POST answered 403 fails with API_ERROR, and the channel is never asked', async () => {
    const { context, calls } = contextWith({ 'Webhook URL': HOOK }, 403);
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toContain('403');
    expect(calls).toEqual([{ url: HOOK, method: 'POST' }]);
    expect(context.asked.map((s) => s.label)).toEqual(['Webhook URL']);
  });

  test('a network failure is an API_ERROR that does not quote the error text', async () => {
    const context = fakeSetupContext({ 'Webhook URL': HOOK });
    context.fetch = (async () => { throw new Error(`boom ${HOOK}`); }) as never;
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toBe('Failed to validate webhook');
    expect(error.message).not.toContain('SECRET-HOOK-TOKEN');
  });

  test('an empty channel gives the suggested name webhook', async () => {
    const { context } = contextWith({ 'Webhook URL': HOOK, 'Channel name': '' });
    const result = await slackProfileAdd({}, context);
    expect(result.suggestedProfileName).toBe('webhook');
    expect(result.credentials).toEqual({ type: 'webhook', webhookUrl: HOOK, channelName: undefined });
    expect(context.asked.map((s) => s.label)).toEqual(['Webhook URL', 'Channel name']);
  });

  test('channel alerts gives the suggested name alerts', async () => {
    const { context } = contextWith({ 'Webhook URL': HOOK, 'Channel name': 'alerts' });
    const result = await slackProfileAdd({}, context);
    expect(result.suggestedProfileName).toBe('alerts');
    expect(result.credentials).toEqual({ type: 'webhook', webhookUrl: HOOK, channelName: 'alerts' });
  });

  test('--profile is not required', async () => {
    const { context } = contextWith({ 'Webhook URL': HOOK, 'Channel name': 'alerts' });
    await expect(slackProfileAdd({ profile: undefined }, context)).resolves.toBeDefined();
  });
});
