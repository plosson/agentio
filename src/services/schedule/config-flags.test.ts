import { describe, expect, test } from 'bun:test';
import {
  buildSchedule,
  configFromFlags,
  missingScheduleFields,
  parseAt,
} from './config-flags';

describe('parseAt', () => {
  test('parses HH:MM', () => {
    expect(parseAt('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseAt('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseAt('23:59')).toEqual({ hour: 23, minute: 59 });
  });
  test('rejects invalid', () => {
    expect(() => parseAt('9')).toThrow();
    expect(() => parseAt('24:00')).toThrow();
    expect(() => parseAt('10:60')).toThrow();
    expect(() => parseAt('abc')).toThrow();
  });
});

describe('buildSchedule', () => {
  test('daily pulls time only', () => {
    expect(buildSchedule('daily', { at: '09:30' })).toEqual({ type: 'daily', hour: 9, minute: 30 });
  });
  test('weekly pulls weekdays + time', () => {
    expect(buildSchedule('weekly', { weekdays: 'mon,fri', at: '08:00' })).toEqual({
      type: 'weekly',
      weekdays: [1, 5],
      hour: 8,
      minute: 0,
    });
  });
  test('monthly pulls day + time', () => {
    expect(buildSchedule('monthly', { day: '15', at: '00:00' })).toEqual({
      type: 'monthly',
      day: 15,
      hour: 0,
      minute: 0,
    });
  });
  test('interval pulls duration', () => {
    expect(buildSchedule('interval', { interval: '1h30m' })).toEqual({ type: 'interval', intervalMinutes: 90 });
  });
  test('manual has no extra fields', () => {
    expect(buildSchedule('manual', { at: '09:00' })).toEqual({ type: 'manual' });
  });
  test('--hour/--minute alternative to --at', () => {
    expect(buildSchedule('daily', { hour: '7', minute: '15' })).toEqual({ type: 'daily', hour: 7, minute: 15 });
  });
  test('rejects out-of-range day', () => {
    expect(() => buildSchedule('monthly', { day: '32', at: '09:00' })).toThrow();
  });
});

describe('missingScheduleFields', () => {
  test('complete schedules report nothing', () => {
    expect(missingScheduleFields({ type: 'manual' })).toEqual([]);
    expect(missingScheduleFields({ type: 'daily', hour: 9, minute: 0 })).toEqual([]);
    expect(missingScheduleFields({ type: 'weekly', weekdays: [1], hour: 9, minute: 0 })).toEqual([]);
    expect(missingScheduleFields({ type: 'monthly', day: 1, hour: 9, minute: 0 })).toEqual([]);
    expect(missingScheduleFields({ type: 'interval', intervalMinutes: 30 })).toEqual([]);
  });
  test('incomplete schedules report missing fields', () => {
    expect(missingScheduleFields({ type: 'daily' }).length).toBeGreaterThan(0);
    expect(missingScheduleFields({ type: 'weekly', hour: 9, minute: 0 })).toContain('weekdays (--weekdays)');
    expect(missingScheduleFields({ type: 'monthly', hour: 9, minute: 0 })).toContain('day (--day)');
    expect(missingScheduleFields({ type: 'interval' })).toContain('interval (--interval)');
  });
});

describe('configFromFlags', () => {
  test('maps permission-mode aliases', () => {
    expect(configFromFlags({ permissionMode: 'bypass' }).permissionMode).toBe('bypassPermissions');
    expect(configFromFlags({ permissionMode: 'accept-edits' }).permissionMode).toBe('acceptEdits');
    expect(configFromFlags({ permissionMode: 'default' }).permissionMode).toBe('default');
  });
  test('only sets passed keys', () => {
    expect(configFromFlags({})).toEqual({});
    expect(configFromFlags({ model: 'haiku' })).toEqual({ model: 'haiku' });
  });
  test('--disabled sets enabled false', () => {
    expect(configFromFlags({ disabled: true }).enabled).toBe(false);
  });
  test('rejects invalid model / schedule / permission-mode', () => {
    expect(() => configFromFlags({ model: 'gpt4' })).toThrow();
    expect(() => configFromFlags({ schedule: 'hourly' })).toThrow();
    expect(() => configFromFlags({ permissionMode: 'nope' })).toThrow();
  });
});
