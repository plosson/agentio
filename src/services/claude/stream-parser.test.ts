import { describe, expect, test } from 'bun:test';
import { parseStreamLine } from './stream-parser';

describe('parseStreamLine', () => {
  test('extracts session_id from system/init event', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' });
    expect(parseStreamLine(line)).toEqual({ kind: 'init', sessionId: 'abc-123' });
  });

  test('extracts assistant text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash' }] },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'assistant_text', text: 'hello' });
  });

  test('extracts final result text', () => {
    const line = JSON.stringify({ type: 'result', result: 'final reply' });
    expect(parseStreamLine(line)).toEqual({ kind: 'result', text: 'final reply' });
  });

  test('returns null for unknown event types', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'whatever' }))).toBeNull();
  });

  test('returns null for non-JSON input', () => {
    expect(parseStreamLine('not json')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseStreamLine('')).toBeNull();
  });

  test('ignores assistant event with no text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    });
    expect(parseStreamLine(line)).toBeNull();
  });
});
