import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'path';
import { resolveInside } from '../../src/utils/safe-path';

const base = '/tmp/agentio-out';

describe('resolveInside', () => {
  test('keeps a plain name inside the directory', () => {
    expect(resolveInside(base, 'report.pdf')).toBe(join(resolve(base), 'report.pdf'));
  });

  test('allows a subfolder', () => {
    expect(resolveInside(base, 'lib/util.gs')).toBe(join(resolve(base), 'lib', 'util.gs'));
  });

  test('works with a relative base directory', () => {
    expect(resolveInside('.', 'a.txt')).toBe(join(process.cwd(), 'a.txt'));
  });

  for (const name of ['../../x', '..', '../x', 'a/../../x', '/etc/passwd', '', '.', 'sub/..']) {
    test(`rejects ${JSON.stringify(name)}`, () => {
      expect(() => resolveInside(base, name)).toThrow(/Refusing to write outside/);
    });
  }

  test('does not treat a sibling with the same prefix as inside', () => {
    expect(() => resolveInside(base, '../agentio-out-evil/x')).toThrow(/Refusing to write outside/);
  });
});
