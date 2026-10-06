import { describe, expect, test } from 'bun:test';
import { fakeSetupContext } from '../../helpers/setup-context';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { slackProfileAdd } from '../../../src/plugins/slack/commands';
import { SLACK_SETUP_NEEDS } from '../../../src/plugins/slack/setup-needs';
import { CliError } from '../../../src/utils/errors';

const vault = withTempVault('agentio-slack-json-', () => ({ config: { profiles: {} } as never }));

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
  test('a URL on another host is refused and fetch is never called', async () => {
    const { context, calls } = contextWith({ webhookUrl: 'https://evil.example.com/x' });
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toBe('Invalid Slack webhook URL');
    expect(calls).toEqual([]);
    expect(context.asked.map((s) => s.id)).toEqual(['webhookUrl']);
  });

  test('a lookalike host is refused', async () => {
    const { context, calls } = contextWith({ webhookUrl: 'https://hooks.slack.com.evil.example/x' });
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(calls).toEqual([]);
  });

  test('an empty webhook URL is refused before any request', async () => {
    const { context, calls } = contextWith({ webhookUrl: '   ' });
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(calls).toEqual([]);
  });

  test('a test POST answered 403 fails with API_ERROR, and the channel is never asked', async () => {
    const { context, calls } = contextWith({ webhookUrl: HOOK }, 403);
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toContain('403');
    expect(calls).toEqual([{ url: HOOK, method: 'POST' }]);
    expect(context.asked.map((s) => s.id)).toEqual(['webhookUrl']);
  });

  test('a network failure is an API_ERROR', async () => {
    const context = fakeSetupContext({ webhookUrl: HOOK });
    context.fetch = (async () => { throw new Error('boom'); }) as never;
    const error = await failure(() => slackProfileAdd({}, context));
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toContain('boom');
  });

  test('an empty channel gives the suggested name webhook', async () => {
    const { context } = contextWith({ webhookUrl: HOOK, channelName: '' });
    const result = await slackProfileAdd({}, context);
    expect(result.suggestedProfileName).toBe('webhook');
    expect(result.credentials).toEqual({ type: 'webhook', webhookUrl: HOOK, channelName: undefined });
    expect(context.asked.map((s) => s.id)).toEqual(['webhookUrl', 'channelName']);
  });

  test('channel alerts gives the suggested name alerts', async () => {
    const { context } = contextWith({ webhookUrl: HOOK, channelName: 'alerts' });
    const result = await slackProfileAdd({}, context);
    expect(result.suggestedProfileName).toBe('alerts');
    expect(result.credentials).toEqual({ type: 'webhook', webhookUrl: HOOK, channelName: 'alerts' });
  });

  test('--profile is not required', async () => {
    const { context } = contextWith({ webhookUrl: HOOK, channelName: 'alerts' });
    await expect(slackProfileAdd({ profile: undefined }, context)).resolves.toBeDefined();
  });
});

const cli = (args: string[], lines: string[] = []) => runCli(['slack', 'profile', 'add', ...args], vault.env(), lines);

describe('slack profile add --json', () => {
  test('--describe --json declares the two inputs and no sign-in', async () => {
    const res = await cli(['--describe', '--json']);
    expect(res.exitCode).toBe(0);
    expect(res.events).toEqual([JSON.parse(JSON.stringify({ v: 1, event: 'needs', service: 'slack', inputs: SLACK_SETUP_NEEDS.inputs, auth: 'none' }))]);
    expect(SLACK_SETUP_NEEDS.inputs.map((i) => i.id)).toEqual(['webhookUrl', 'channelName']);
  }, 30_000);

  test('a foreign host: one error event, no secret in stdout', async () => {
    const res = await cli(['--json', '--input', '-'], [JSON.stringify({ webhookUrl: 'https://evil.example.com/SECRET-PATH' })]);
    expect(res.exitCode).not.toBe(0);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
    expect(res.stdout).not.toContain('SECRET-PATH');
  }, 30_000);

  test('unknown ids and wrong types are refused', async () => {
    for (const line of [`{"webhookUrl":42}`, `{"webhookUrl":"${HOOK}","x":"y"}`, 'not json']) {
      const res = await cli(['--json', '--input', '-'], [line]);
      expect(res.exitCode).not.toBe(0);
      expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
      expect(res.stdout).not.toContain('SECRET-HOOK-TOKEN');
    }
  }, 60_000);

  test('stdin closed with no inputs: No answer for "Webhook URL"', async () => {
    const res = await cli(['--json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Webhook URL"' });
  }, 30_000);
});
