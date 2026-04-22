import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { walkRunFiles } from './walker';

describe('walkRunFiles', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentio-walk-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function touch(rel: string): void {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '');
  }

  test('finds *.run.md files in subtree', () => {
    touch('foo.run.md');
    touch('prompts/bar.run.md');
    touch('deep/nested/baz.run.md');
    touch('README.md');
    const result = walkRunFiles(root);
    expect(result.map((r) => r.id).sort()).toEqual(['bar', 'baz', 'foo']);
  });

  test('skips node_modules, .git, .agentio/runs', () => {
    touch('real.run.md');
    touch('node_modules/a.run.md');
    touch('.git/hidden.run.md');
    touch('.agentio/runs/x/ignored.run.md');
    const result = walkRunFiles(root);
    expect(result.map((r) => r.id)).toEqual(['real']);
  });

  test('id = filename minus .run.md', () => {
    touch('my-task.run.md');
    const result = walkRunFiles(root);
    expect(result[0].id).toBe('my-task');
  });
});
