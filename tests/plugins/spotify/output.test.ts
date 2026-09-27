import { describe, expect, test } from 'bun:test';
import { formatDuration, parseDuration } from '../../../src/plugins/spotify/output';

describe('durations', () => {
  test('formats m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(4 * 60_000 + 24_000)).toBe('4:24');
  });

  test('parses m:ss and ms', () => {
    expect(parseDuration('1:05')).toBe(65_000);
    expect(parseDuration('65000')).toBe(65_000);
  });
});
