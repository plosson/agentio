import { describe, expect, test } from 'bun:test';
import { configFromFlags, scheduleFromFlags } from './schedule';
import { CliError } from '../utils/errors';

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
});
