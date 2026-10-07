import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import type { SqlCredentials } from '../../../src/plugins/sql/types';

const vault = withTempVault('agentio-sql-json-', () => ({ config: { profiles: {} } as never }));
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agentio-sql-db-')); });
afterEach(() => rm(dir, { recursive: true, force: true }));

const cli = (args: string[], lines: string[] = []) => runCli(['sql', 'profile', 'add', ...args], vault.env(), lines);

test('--describe --json: one secret url input; no sign-in', async () => {
  const res = await cli(['--describe', '--json']);
  expect(res.exitCode, res.stdout + res.stderr).toBe(0);
  expect(res.events).toEqual([{
    v: 1, event: 'needs', service: 'sql', auth: 'none',
    inputs: [{
      id: 'url', label: 'Connection URL', kind: 'secret',
      help: 'postgres://user:password@host:5432/db, mysql://user:password@host:3306/db or sqlite:///path/to/file.db',
    }],
  }]);
}, 30_000);

test('malformed or unknown --input lines are refused; dbType is not a declared input', async () => {
  for (const line of ['not json', '[]', '{"url":42}', '{"url":""}', `{"url":"sqlite://${dir}/a.db","x":"y"}`, '{"dbType":"sqlite"}']) {
    const res = await cli(['--json', '--input', '-'], [line]);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
  }
}, 120_000);

test('--input without a url line: stdin closed gives No answer for "Connection URL"', async () => {
  const res = await cli(['--json', '--input', '-'], ['{}']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([
    expect.objectContaining({ event: 'ask', id: 'url', kind: 'secret' }),
    expect.objectContaining({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Connection URL"' }),
  ]);
}, 30_000);

test('a failing server connection: the reason is kept, the password is nowhere', async () => {
  const password = 'SECRET-PW #1/@';
  const encoded = encodeURIComponent(password);
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: `postgres://u:${encoded}@127.0.0.1:1/db` })]);
  expect(res.exitCode).not.toBe(0);
  const error = res.events.at(-1);
  expect(error).toMatchObject({ event: 'error', code: 'AUTH_FAILED' });
  expect(error.message).toMatch(/^Failed to connect to u@127\.0\.0\.1\/db: \S/);
  for (const secret of ['SECRET-PW', password, encoded]) {
    expect(res.stdout).not.toContain(secret);
    expect(res.stderr).not.toContain(secret);
  }
}, 30_000);

test('a sqlite file in a missing directory: the driver reason is kept', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: `sqlite://${dir}/no/such/dir/a.db` })]);
  expect(res.exitCode).not.toBe(0);
  const error = res.events.at(-1);
  expect(error).toMatchObject({ event: 'error', code: 'AUTH_FAILED' });
  expect(error.message).toMatch(/^Failed to connect to .+: \S/);
  expect(error.message).toContain('unable to open database file');
}, 30_000);

test('--interactive --json: a failing connection never shows the typed password', async () => {
  const password = 'SECRET-PW %2F/@:';
  const res = await cli(['--json', '--interactive'], [
    '{"id":"dbType","value":"postgres"}',
    '{"id":"host","value":"127.0.0.1"}',
    '{"id":"port","value":"1"}',
    '{"id":"database","value":"db"}',
    '{"id":"user","value":"u"}',
    JSON.stringify({ id: 'password', value: password }),
  ]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1).message).toMatch(/^Failed to connect to u@127\.0\.0\.1\/db: \S/);
  for (const secret of ['SECRET-PW', password, encodeURIComponent(password)]) {
    expect(res.stdout).not.toContain(secret);
    expect(res.stderr).not.toContain(secret);
  }
}, 30_000);

test('a malformed url does not echo the password', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: 'postgres://u:SECRET-PW@host:notaport/db' })]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error' });
  expect(res.stdout).not.toContain('SECRET-PW');
  expect(res.stderr).not.toContain('SECRET-PW');
}, 30_000);

test('--interactive --json with stdin closed: ask dbType, then No answer, nothing else', async () => {
  const res = await cli(['--json', '--interactive']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([
    {
      v: 1, event: 'ask', id: 'dbType', label: 'Database type', kind: 'choice',
      choices: [{ value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }, { value: 'sqlite', label: 'SQLite' }],
    },
    { v: 1, event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Database type"' },
  ]);
}, 30_000);

test('--interactive --json: a wrong dbType answer is refused', async () => {
  const res = await cli(['--json', '--interactive'], ['{"id":"dbType","value":"oracle"}']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
}, 30_000);

test('--interactive --json, server type: asks the parts in order, then stops at the closed stdin', async () => {
  const res = await cli(['--json', '--interactive'], ['{"id":"dbType","value":"postgres"}', '{"id":"host","value":"127.0.0.1"}']);
  expect(res.events.filter((e) => e.event === 'ask').map((e) => e.id)).toEqual(['dbType', 'host', 'port']);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', message: 'No answer for "Port"' });
}, 30_000);

test('--interactive --json, sqlite: added', async () => {
  const path = join(dir, 'b.db');
  const res = await cli(['--json', '--interactive'], ['{"id":"dbType","value":"sqlite"}', JSON.stringify({ id: 'path', value: path })]);
  expect(res.exitCode, res.stdout + res.stderr).toBe(0);
  expect(res.events.filter((e) => e.event === 'ask').map((e) => e.id)).toEqual(['dbType', 'path']);
  expect(res.events.at(-1)).toMatchObject({ event: 'added', service: 'sql', readOnly: false });
  const profile = res.events.at(-1).profile as string;
  expect(await getCredentials<SqlCredentials>('sql', profile)).toMatchObject({ url: `sqlite://${path}` });
}, 30_000);

test('--json --input -: a sqlite url is added; the display name is the profile', async () => {
  const url = `sqlite://${dir}/a.db`;
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url })]);
  expect(res.exitCode, res.stdout + res.stderr).toBe(0);
  expect(res.events).toHaveLength(1);
  const added = res.events[0];
  expect(added).toMatchObject({ event: 'added', service: 'sql', readOnly: false });
  // A profile name cannot hold "/", so the suggested name swaps it for "-".
  const displayName = `localhost/${dir.replace(/^\//, '')}/a.db`;
  expect(added.profile).toBe(displayName.replaceAll('/', '-'));
  expect(await getCredentials<SqlCredentials>('sql', added.profile)).toEqual({ url, displayName });
}, 30_000);
