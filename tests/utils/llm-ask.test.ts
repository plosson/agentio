import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { caught } from '../helpers/caught';
import { askRequest, printAnswer, readPrompt } from '../../src/utils/llm-ask';

const stdin = (value: string | null) => async () => value;

test('the prompt, then piped stdin after a blank line', async () => {
  expect(await readPrompt('claude', 'Review this', stdin('diff --git\n'))).toBe('Review this\n\ndiff --git');
  expect(await readPrompt('claude', undefined, stdin('only stdin'))).toBe('only stdin');
  expect(await readPrompt('claude', 'only arg', stdin(null))).toBe('only arg');
});

test('nothing at all, or only blanks, is refused with how to give a prompt', async () => {
  for (const [arg, piped] of [[undefined, null], ['  ', null], [undefined, ' \n '], ['', '']] as const) {
    const err = await caught(readPrompt('claude', arg, stdin(piped)));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.suggestion).toContain('agentio claude ask');
  }
});

test('blank --model, --system or --effort are refused; given ones are trimmed', async () => {
  for (const key of ['model', 'system', 'effort'] as const) {
    const err = await caught(askRequest('claude', 'hi', { [key]: '  ' }, stdin(null)));
    expect(err.message).toContain(`--${key}`);
  }
  expect(await askRequest('claude', 'hi', { model: ' opus ' }, stdin(null))).toEqual({ prompt: 'hi', model: 'opus', system: undefined, effort: undefined });
});

let write: ReturnType<typeof spyOn>;
beforeEach(() => { write = spyOn(process.stdout, 'write').mockImplementation(() => true); });
afterEach(() => write.mockRestore());

test('text output is the answer alone, ending with one newline', () => {
  printAnswer({ answer: 'Paris', model: null, usage: null, costUsd: null, durationMs: 1 });
  printAnswer({ answer: 'Line\n', model: null, usage: null, costUsd: null, durationMs: 1 });
  expect(write.mock.calls.map((c: unknown[]) => c[0])).toEqual(['Paris\n', 'Line\n']);
});

test('--json output is the whole result', () => {
  const result = { answer: 'Paris', model: 'm', usage: { input_tokens: 1 }, costUsd: 0.01, durationMs: 5 };
  printAnswer(result, true);
  expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual(result);
});
