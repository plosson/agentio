import { describe, expect, test } from 'bun:test';
import { decideDaemonAction } from './daemon-ensure';

describe('decideDaemonAction', () => {
  test('returns "running" when fetch /health succeeds', () => {
    expect(decideDaemonAction({ healthOk: true, installed: false })).toBe('running');
  });
  test('returns "start" when not running but installed', () => {
    expect(decideDaemonAction({ healthOk: false, installed: true })).toBe('start');
  });
  test('returns "install" when not installed at all', () => {
    expect(decideDaemonAction({ healthOk: false, installed: false })).toBe('install');
  });
});
