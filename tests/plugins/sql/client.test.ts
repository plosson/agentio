import { afterEach, describe, expect, test } from 'bun:test';
import { SqlClient, assertSingleReadOnlyStatement } from '../../../src/plugins/sql/client';

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
