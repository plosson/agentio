import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fakeSetupContext } from '../../helpers/setup-context';
import { sqlProfileAdd, SQL_URL_INPUT } from '../../../src/plugins/sql/commands';
import { CliError } from '../../../src/utils/errors';

let dir: string;
let printed: string[];
const originalError = console.error;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentio-sql-db-'));
  printed = [];
  console.error = (...parts: unknown[]) => { printed.push(parts.join(' ')); };
});
afterEach(async () => {
  console.error = originalError;
  await rm(dir, { recursive: true, force: true });
});

/** A scripted context whose logs land with what the driver prints, so a test can look for a secret in both. */
function context(answers: Record<string, string>) {
  return { ...fakeSetupContext(answers), log: (...parts: unknown[]) => { printed.push(parts.join(' ')); } };
}

async function refusal(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

function expectNowhere(err: CliError, secrets: string[]): void {
  for (const secret of secrets) {
    expect(`${err.message} ${err.suggestion ?? ''}`).not.toContain(secret);
    expect(printed.join('\n')).not.toContain(secret);
  }
}

test('the connection URL is asked as a secret; an empty one is refused before any connection', async () => {
  const ctx = context({ 'Connection URL': '' });
  const err = await refusal(sqlProfileAdd({}, ctx));
  expect([err.code, err.message]).toEqual(['INVALID_PARAMS', 'Connection URL is required']);
  expect(ctx.asked).toEqual([SQL_URL_INPUT]);
  expect(SQL_URL_INPUT.kind).toBe('secret');
  expect(printed.join('\n')).not.toContain('Validating connection');
});

test('a failing server connection: the reason is kept, the password is nowhere', async () => {
  const password = 'SECRET-PW #1/@';
  const encoded = encodeURIComponent(password);
  const err = await refusal(sqlProfileAdd({}, context({ 'Connection URL': `postgres://u:${encoded}@127.0.0.1:1/db` })));
  expect(err.code).toBe('AUTH_FAILED');
  expect(err.message).toMatch(/^Failed to connect to u@127\.0\.0\.1\/db: \S/);
  expectNowhere(err, ['SECRET-PW', password, encoded]);
});

test('a malformed url does not echo the password', async () => {
  const err = await refusal(sqlProfileAdd({}, context({ 'Connection URL': 'postgres://u:SECRET-PW@host:notaport/db' })));
  expectNowhere(err, ['SECRET-PW']);
});

test('a sqlite file in a missing directory: the driver reason is kept', async () => {
  const err = await refusal(sqlProfileAdd({}, context({ 'Connection URL': `sqlite://${dir}/no/such/dir/a.db` })));
  expect(err.code).toBe('AUTH_FAILED');
  expect(err.message).toMatch(/^Failed to connect to .+: \S/);
  expect(err.message).toContain('unable to open database file');
});

test('a sqlite url is kept; the display name is the profile name, with "/" swapped for "-"', async () => {
  const url = `sqlite://${dir}/a.db`;
  const result = await sqlProfileAdd({}, context({ 'Connection URL': url }));
  const displayName = `localhost/${dir.replace(/^\//, '')}/a.db`;
  expect(result.credentials).toEqual({ url, displayName });
  expect(result.suggestedProfileName).toBe(displayName.replaceAll('/', '-'));
});

test('--interactive: the database type is a choice, and an answer outside it is refused', async () => {
  const ctx = context({ 'Database type': 'oracle' });
  const err = await refusal(sqlProfileAdd({ interactive: true }, ctx));
  expect([err.code, err.message]).toEqual(['INVALID_PARAMS', 'Database type must be one of: postgres, mysql, sqlite']);
  expect(ctx.asked.map((s) => s.label)).toEqual(['Database type']);
});

test('--interactive, server type: the parts are asked in order, and a failing connection never shows the typed password', async () => {
  const password = 'SECRET-PW %2F/@:';
  const ctx = context({ 'Database type': 'postgres', Host: '127.0.0.1', Port: '1', 'Database name': 'db', Username: 'u', Password: password });
  const err = await refusal(sqlProfileAdd({ interactive: true }, ctx));
  expect(ctx.asked.map((s) => s.label)).toEqual(['Database type', 'Host', 'Port', 'Database name', 'Username', 'Password']);
  expect(ctx.asked.at(-1)?.kind).toBe('secret');
  expect(err.message).toMatch(/^Failed to connect to u@127\.0\.0\.1\/db: \S/);
  expectNowhere(err, ['SECRET-PW', password, encodeURIComponent(password)]);
});

test('--interactive, sqlite: only the path is asked', async () => {
  const path = join(dir, 'b.db');
  const ctx = context({ 'Database type': 'sqlite', 'Database file path': path });
  const result = await sqlProfileAdd({ interactive: true }, ctx);
  expect(ctx.asked.map((s) => s.label)).toEqual(['Database type', 'Database file path']);
  expect(result.credentials).toMatchObject({ url: `sqlite://${path}` });
});
