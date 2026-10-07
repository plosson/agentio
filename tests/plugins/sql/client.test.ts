import { afterEach, describe, expect, test } from 'bun:test';
import { SqlClient, assertSingleReadOnlyStatement, scrubConnectionSecrets } from '../../../src/plugins/sql/client';

const clients: SqlClient[] = [];

function client(): SqlClient {
  const instance = new SqlClient({ url: 'sqlite://:memory:', displayName: 'memory' });
  clients.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.close();
});

describe('SQL read-only execution', () => {
  test('lets a read-only profile query data', async () => {
    const sql = client();
    await sql.query({ query: 'CREATE TABLE items (id INTEGER)' });
    await sql.query({ query: 'INSERT INTO items VALUES (1)' });
    const result = await sql.query({ query: 'SELECT * FROM items' }, { readOnly: true });
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  test('the database refuses writes regardless of their first keyword', async () => {
    const sql = client();
    await sql.query({ query: 'CREATE TABLE items (id INTEGER)' });
    await expect(sql.query({ query: 'WITH value(id) AS (SELECT 1) INSERT INTO items SELECT id FROM value' }, { readOnly: true }))
      .rejects.toMatchObject({ code: 'API_ERROR' });
    expect((await sql.query({ query: 'SELECT * FROM items' })).rows).toEqual([]);
  });

  test('rejects stacked statements and attempts to disable the guard', () => {
    expect(() => assertSingleReadOnlyStatement('SELECT 1; DELETE FROM items')).toThrow(/exactly one statement/);
    expect(() => assertSingleReadOnlyStatement('PRAGMA query_only = OFF')).toThrow(/not allowed/);
    expect(() => assertSingleReadOnlyStatement("SELECT ';' AS value; -- one statement")).not.toThrow();
  });
});

describe('scrubConnectionSecrets', () => {
  const password = 'p@ss w/rd';
  const encoded = encodeURIComponent(password);
  const url = `postgres://u:${encoded}@db.example/app`;

  test('removes the URL, the raw password and the URL-encoded password', () => {
    const message = `could not reach ${url}; password "${password}" (${encoded}) refused`;
    const scrubbed = scrubConnectionSecrets(message, url);
    expect(scrubbed).not.toContain(url);
    expect(scrubbed).not.toContain(password);
    expect(scrubbed).not.toContain(encoded);
    expect(scrubbed).toContain('could not reach');
  });

  test('a URL without a password, or not a URL at all, only loses the URL itself', () => {
    expect(scrubConnectionSecrets('Failed to connect', 'postgres://u@h/db')).toBe('Failed to connect');
    expect(scrubConnectionSecrets('bad host:notaport', 'postgres://u:pw@host:notaport/db')).toBe('bad host:notaport');
    expect(scrubConnectionSecrets('see postgres://u:pw@host:notaport/db', 'postgres://u:pw@host:notaport/db')).not.toContain('pw');
  });

  test('an empty password does not erase the message', () => {
    expect(scrubConnectionSecrets('Failed to connect', 'postgres://u:@h/db')).toBe('Failed to connect');
  });
});
