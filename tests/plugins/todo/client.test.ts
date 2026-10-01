import { afterEach, beforeEach, expect, test } from 'bun:test';
import { TodoClient, normaliseBaseUrl } from '../../../src/plugins/todo/client';
import { CliError } from '../../../src/utils/errors';
import { FakeTodo, caught } from './fake-todo';

test('normaliseBaseUrl adds https and strips trailing slash', () => {
  expect(normaliseBaseUrl('todo.example.com')).toBe('https://todo.example.com');
  expect(normaliseBaseUrl('https://todo.example.com/')).toBe('https://todo.example.com');
  expect(normaliseBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
});

test('normaliseBaseUrl rejects empty and bad schemes', () => {
  expect(() => normaliseBaseUrl('')).toThrow(CliError);
  expect(() => normaliseBaseUrl('ftp://x.com')).toThrow(CliError);
});

let fake: FakeTodo;
let client: TodoClient;

beforeEach(() => {
  fake = new FakeTodo();
  fake.tokens.set('tok', 'me@example.com');
  client = new TodoClient({ baseUrl: fake.url, token: 'tok' });
});

afterEach(() => fake.stop());

test('me returns email', async () => {
  const me = await client.me();
  expect(me.email).toBe('me@example.com');
});

test('create list check remove', async () => {
  const created = await client.create({ title: 'Buy milk', tags: ['errands'] });
  expect(created.id.startsWith('tod_')).toBe(true);
  expect(created.tags).toEqual(['errands']);

  const open = await client.list({ status: 'open' });
  expect(open).toHaveLength(1);

  const checked = await client.check(created.id);
  expect(checked.done).toBe(true);

  const done = await client.list({ status: 'done', tag: 'errands' });
  expect(done).toHaveLength(1);

  await client.remove(created.id);
  const e = await caught(client.get(created.id));
  expect(e.code).toBe('NOT_FOUND');
});

test('401 becomes AUTH_EXPIRED', async () => {
  const bad = new TodoClient({ baseUrl: fake.url, token: 'nope' });
  const e = await caught(bad.me());
  expect(e.code).toBe('AUTH_EXPIRED');
});

test('validate reports email', async () => {
  const v = await client.validate();
  expect(v.valid).toBe(true);
  expect(v.info).toBe('me@example.com');
});
