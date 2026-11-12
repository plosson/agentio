import { describe, expect, test } from 'bun:test';
import type { OAuth2Client } from 'google-auth-library';
import { GCalClient } from '../../../../src/plugins/google/gcal/client';
import { isIanaTimeZone, parseTimeZone } from '../../../../src/plugins/google/gcal/timezone';
import { CliError } from '../../../../src/utils/errors';

interface Fake {
  calendarZone?: string | null;
  settingZone?: string;
  current?: Record<string, any>;
}

function makeClient(fake: Fake = {}) {
  const client = new GCalClient({} as OAuth2Client);
  const calls = { insert: [] as any[], patch: [] as any[], get: 0, calendars: 0, settings: 0 };
  const echo = (body: any) => ({ data: { id: 'ev1', status: 'confirmed', ...body.requestBody } });
  (client as any).calendar = {
    calendars: { get: async () => { calls.calendars++; return { data: { timeZone: fake.calendarZone === undefined ? 'Europe/Brussels' : fake.calendarZone } }; } },
    settings: { get: async () => { calls.settings++; return { data: { value: fake.settingZone } }; } },
    events: {
      insert: async (body: any) => { calls.insert.push(body); return echo(body); },
      patch: async (body: any) => { calls.patch.push(body); return echo(body); },
      get: async () => { calls.get++; return { data: fake.current ?? {} }; },
    },
  };
  return { client, calls };
}

const FROM = '2026-11-16T14:00:00+01:00';
const TO = '2026-11-16T15:00:00+01:00';
const WEEKLY = ['RRULE:FREQ=WEEKLY;BYDAY=MO'];

describe('time zone names', () => {
  test('IANA names pass, offsets and junk do not', () => {
    for (const ok of ['Europe/Brussels', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+1']) expect(isIanaTimeZone(ok)).toBe(true);
    for (const bad of ['+01:00', 'Europe/Nowhere', 'CET+1', '', 'Europe/', '../etc']) expect(isIanaTimeZone(bad)).toBe(false);
  });

  test('--timezone is checked before anything is called', () => {
    expect(parseTimeZone(undefined)).toBeUndefined();
    expect(parseTimeZone(' Europe/Brussels ')).toBe('Europe/Brussels');
    expect(() => parseTimeZone('+01:00')).toThrow(CliError);
  });
});

describe('createEvent', () => {
  test('a recurring timed event without --timezone takes the calendar time zone', async () => {
    const { client, calls } = makeClient({ calendarZone: 'Europe/Brussels' });
    await client.createEvent({ summary: 'x', start: FROM, end: TO, recurrence: WEEKLY });
    const body = calls.insert[0].requestBody;
    expect(body.start).toEqual({ dateTime: FROM, timeZone: 'Europe/Brussels' });
    expect(body.end).toEqual({ dateTime: TO, timeZone: 'Europe/Brussels' });
    expect(body.recurrence).toEqual(WEEKLY);
  });

  test('--timezone wins and the calendar is not read', async () => {
    const { client, calls } = makeClient();
    await client.createEvent({ summary: 'x', start: FROM, end: TO, recurrence: WEEKLY, timeZone: 'America/New_York' });
    expect(calls.insert[0].requestBody.start).toEqual({ dateTime: FROM, timeZone: 'America/New_York' });
    expect(calls.calendars).toBe(0);
  });

  test('a calendar without a time zone falls back to the account setting', async () => {
    const { client, calls } = makeClient({ calendarZone: null, settingZone: 'Europe/Paris' });
    await client.createEvent({ summary: 'x', start: FROM, end: TO, recurrence: WEEKLY });
    expect(calls.insert[0].requestBody.start.timeZone).toBe('Europe/Paris');
  });

  test('a one-off event is sent as before, with no time zone and no extra call', async () => {
    const { client, calls } = makeClient();
    await client.createEvent({ summary: 'x', start: FROM, end: TO });
    expect(calls.insert[0].requestBody.start).toEqual({ dateTime: FROM });
    expect(calls.calendars).toBe(0);
  });

  test('a recurring all-day event uses dates and needs no time zone', async () => {
    const { client, calls } = makeClient();
    await client.createEvent({ summary: 'x', start: '2026-06-12', end: '2026-06-13', allDay: true, recurrence: ['RRULE:FREQ=YEARLY'] });
    expect(calls.insert[0].requestBody.start).toEqual({ date: '2026-06-12' });
    expect(calls.insert[0].requestBody.end).toEqual({ date: '2026-06-13' });
    expect(calls.calendars).toBe(0);
  });

  test('--all-day with full timestamps keeps only the dates', async () => {
    const { client, calls } = makeClient();
    await client.createEvent({ summary: 'x', start: FROM, end: '2026-11-17T00:00:00+01:00', allDay: true, recurrence: WEEKLY });
    expect(calls.insert[0].requestBody.start).toEqual({ date: '2026-11-16' });
    expect(calls.insert[0].requestBody.end).toEqual({ date: '2026-11-17' });
  });
});

describe('updateEvent', () => {
  test('adding a recurrence re-sends the current times with the calendar time zone', async () => {
    const { client, calls } = makeClient({ current: { start: { dateTime: FROM }, end: { dateTime: TO } } });
    await client.updateEvent({ eventId: 'ev1', recurrence: WEEKLY });
    const body = calls.patch[0].requestBody;
    expect(body.recurrence).toEqual(WEEKLY);
    expect(body.start).toEqual({ dateTime: FROM, timeZone: 'Europe/Brussels' });
    expect(body.end).toEqual({ dateTime: TO, timeZone: 'Europe/Brussels' });
  });

  test('moving a recurring event keeps its own time zone', async () => {
    const { client, calls } = makeClient({
      current: { recurrence: WEEKLY, start: { dateTime: FROM, timeZone: 'Asia/Tokyo' }, end: { dateTime: TO, timeZone: 'Asia/Tokyo' } },
    });
    await client.updateEvent({ eventId: 'ev1', start: '2026-11-16T16:00:00+01:00', end: '2026-11-16T17:00:00+01:00' });
    expect(calls.patch[0].requestBody.start).toEqual({ dateTime: '2026-11-16T16:00:00+01:00', timeZone: 'Asia/Tokyo' });
    expect(calls.calendars).toBe(0);
  });

  test('moving a one-off event sends no time zone', async () => {
    const { client, calls } = makeClient({ current: { start: { dateTime: FROM }, end: { dateTime: TO } } });
    await client.updateEvent({ eventId: 'ev1', start: '2026-11-16T16:00:00+01:00', end: '2026-11-16T17:00:00+01:00' });
    expect(calls.patch[0].requestBody.start).toEqual({ dateTime: '2026-11-16T16:00:00+01:00' });
  });

  test('--timezone alone re-zones the current times', async () => {
    const { client, calls } = makeClient({ current: { start: { dateTime: FROM }, end: { dateTime: TO } } });
    await client.updateEvent({ eventId: 'ev1', timeZone: 'Europe/London' });
    expect(calls.patch[0].requestBody.start).toEqual({ dateTime: FROM, timeZone: 'Europe/London' });
    expect(calls.patch[0].requestBody.end).toEqual({ dateTime: TO, timeZone: 'Europe/London' });
  });

  test('a summary change reads nothing first', async () => {
    const { client, calls } = makeClient();
    await client.updateEvent({ eventId: 'ev1', summary: 'Renamed' });
    expect(calls.get).toBe(0);
    expect(calls.patch[0].requestBody).toEqual({ summary: 'Renamed' });
  });
});
