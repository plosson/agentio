import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateLegacyFiles } from './path-migration';

describe('migrateLegacyFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentio-pm-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('renames gateway.db to daemon.db when target absent', () => {
    writeFileSync(join(dir, 'gateway.db'), 'dbcontent');
    migrateLegacyFiles(dir);
    expect(existsSync(join(dir, 'daemon.db'))).toBe(true);
    expect(existsSync(join(dir, 'gateway.db'))).toBe(false);
    expect(readFileSync(join(dir, 'daemon.db'), 'utf8')).toBe('dbcontent');
  });

  test('leaves gateway.db alone when daemon.db already exists', () => {
    writeFileSync(join(dir, 'gateway.db'), 'old');
    writeFileSync(join(dir, 'daemon.db'), 'new');
    migrateLegacyFiles(dir);
    expect(readFileSync(join(dir, 'gateway.db'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'daemon.db'), 'utf8')).toBe('new');
  });

  test('also migrates gateway.log', () => {
    writeFileSync(join(dir, 'gateway.log'), 'logs');
    migrateLegacyFiles(dir);
    expect(existsSync(join(dir, 'daemon.log'))).toBe(true);
  });

  test('no-op when neither exists', () => {
    migrateLegacyFiles(dir);
    expect(existsSync(join(dir, 'daemon.db'))).toBe(false);
  });
});
