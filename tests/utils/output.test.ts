import { describe, expect, test } from 'bun:test';
import { abbrHome, boldStderr } from '../../src/utils/output';

describe('abbrHome', () => {
  test('replaces $HOME prefix with ~', () => {
    expect(abbrHome('/Users/alice/projects/x', '/Users/alice')).toBe('~/projects/x');
  });
  test('returns ~ when path equals home', () => {
    expect(abbrHome('/Users/alice', '/Users/alice')).toBe('~');
  });
  test('leaves unrelated paths unchanged', () => {
    expect(abbrHome('/tmp/foo', '/Users/alice')).toBe('/tmp/foo');
  });
  test('does not match a prefix that is not a path boundary', () => {
    expect(abbrHome('/Users/alicia/x', '/Users/alice')).toBe('/Users/alicia/x');
  });
});

describe('boldStderr', () => {
  function capture(isTTY: boolean | undefined, env: Record<string, string | undefined> = {}, run: () => void): string[] {
    const original = { error: console.error, warn: console.warn };
    const written: string[] = [];
    boldStderr({ write: (text: string) => written.push(text), isTTY }, env);
    try {
      run();
    } finally {
      Object.assign(console, original);
    }
    return written;
  }

  test('on a terminal, console.error and console.warn print in bold, not in colour', () => {
    const written = capture(true, {}, () => {
      console.error('Waiting for approval…');
      console.warn('Careful');
    });
    expect(written).toEqual(['\x1b[1mWaiting for approval…\x1b[22m\n', '\x1b[1mCareful\x1b[22m\n']);
  });

  test('a message over several lines is bold as a whole; an empty line has no codes', () => {
    const written = capture(true, {}, () => {
      console.error('To sign in, open:\n  https://x.example');
      console.error();
    });
    expect(written).toEqual(['\x1b[1mTo sign in, open:\n  https://x.example\x1b[22m\n', '\n']);
  });

  test('a pipe, an unknown stream or NO_COLOR gets plain text', () => {
    for (const [isTTY, env] of [
      [false, {}],
      [undefined, {}],
      [true, { NO_COLOR: '1' }],
      [true, { NO_COLOR: 'false' }],
    ] as const) {
      const written = capture(isTTY, env, () => console.error('Stored on the vault hub'));
      expect(written).toEqual(['Stored on the vault hub\n']);
    }
  });

  test('an empty NO_COLOR does not turn bold off', () => {
    expect(capture(true, { NO_COLOR: '' }, () => console.error('x'))).toEqual(['\x1b[1mx\x1b[22m\n']);
  });

  test('arguments are formatted like console.error: specifiers, numbers, objects, errors', () => {
    const written = capture(false, {}, () => {
      console.error('%s has %d profiles', 'gmail', 2);
      console.error('Error:', 'no hub', 42, { code: 'X' });
      console.error(new Error('boom'));
    });
    expect(written[0]).toBe('gmail has 2 profiles\n');
    expect(written[1]).toBe("Error: no hub 42 { code: 'X' }\n");
    expect(written[2]).toStartWith('Error: boom\n');
    expect(written.join('')).not.toContain('\x1b[');
  });
});
