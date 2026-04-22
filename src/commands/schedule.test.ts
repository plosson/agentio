import { describe, expect, test } from 'bun:test';
import { configFromFlags, scheduleFromFlags, applyScheduleType, abbrHome } from './schedule';
import { CliError } from '../utils/errors';
import type { Schedule } from '../types/schedule';

describe('scheduleFromFlags', () => {
  test('daily with --at', () => {
    expect(scheduleFromFlags({ schedule: 'daily', at: '21:00' })).toEqual({
      type: 'daily', hour: 21, minute: 0,
    });
  });
  test('weekly with weekdays', () => {
    expect(scheduleFromFlags({ schedule: 'weekly', at: '09:00', weekdays: 'mon,wed,fri' })).toEqual({
      type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5],
    });
  });
  test('interval with duration', () => {
    expect(scheduleFromFlags({ schedule: 'interval', interval: '30m' })).toEqual({
      type: 'interval', intervalMinutes: 30,
    });
  });
  test('invalid schedule type throws CliError', () => {
    expect(() => scheduleFromFlags({ schedule: 'bogus' })).toThrow(CliError);
  });
});

describe('configFromFlags', () => {
  test('maps --permission-mode bypass -> bypassPermissions', () => {
    expect(configFromFlags({ permissionMode: 'bypass' }).permissionMode).toBe('bypassPermissions');
  });
  test('rejects bad --model', () => {
    expect(() => configFromFlags({ model: 'gpt' })).toThrow(CliError);
  });
  test('--disabled sets enabled: false', () => {
    expect(configFromFlags({ disabled: true }).enabled).toBe(false);
  });
  test('--host is passed through', () => {
    expect(configFromFlags({ host: 'mac-1' }).host).toBe('mac-1');
  });
  test('--enable sets enabled: true', () => {
    expect(configFromFlags({ enable: true }).enabled).toBe(true);
  });
  test('--enable + --disabled together throws CliError', () => {
    expect(() => configFromFlags({ enable: true, disabled: true })).toThrow(CliError);
  });
});

describe('applyScheduleType', () => {
  test('weekly -> daily drops weekdays, keeps hour/minute', () => {
    expect(applyScheduleType(
      { type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] },
      'daily'
    )).toEqual({ type: 'daily', hour: 9, minute: 0 });
  });
  test('daily -> interval drops hour/minute', () => {
    expect(applyScheduleType(
      { type: 'daily', hour: 9, minute: 0 },
      'interval'
    )).toEqual({ type: 'interval' });
  });
  test('daily -> monthly keeps hour/minute, no day', () => {
    expect(applyScheduleType(
      { type: 'daily', hour: 9, minute: 30 },
      'monthly'
    )).toEqual({ type: 'monthly', hour: 9, minute: 30 });
  });
  test('interval -> manual drops intervalMinutes', () => {
    expect(applyScheduleType(
      { type: 'interval', intervalMinutes: 30 },
      'manual'
    )).toEqual({ type: 'manual' });
  });
  test('same type is a no-op', () => {
    const s: Schedule = { type: 'weekly', hour: 9, minute: 0, weekdays: [2] };
    expect(applyScheduleType(s, 'weekly')).toEqual(s);
  });
});

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
