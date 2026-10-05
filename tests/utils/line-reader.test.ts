import { expect, test } from 'bun:test';
import { PassThrough } from 'stream';
import { createLineReader } from '../../src/utils/line-reader';

test('lines that arrive together are all kept, in order, and blank lines are skipped', async () => {
  const input = new PassThrough();
  const reader = createLineReader(input);
  input.write('{"a":1}\n\n  \n{"id":"x","value":"y"}\r\n');
  expect(await reader.next()).toBe('{"a":1}');
  expect(await reader.next()).toBe('{"id":"x","value":"y"}');
  reader.close();
});

test('a line asked for before it arrives is delivered when it does', async () => {
  const input = new PassThrough();
  const reader = createLineReader(input);
  const pending = reader.next();
  input.write('late\n');
  expect(await pending).toBe('late');
  reader.close();
});

test('a closed input answers null, now and for every later call, without hanging', async () => {
  const input = new PassThrough();
  const reader = createLineReader(input);
  const waiting = reader.next();
  input.end('last line without newline');
  expect(await waiting).toBe('last line without newline');
  expect(await reader.next()).toBeNull();
  expect(await reader.next()).toBeNull();
});
