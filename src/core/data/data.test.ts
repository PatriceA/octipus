/**
 * The read-only guarantee and the file reader behind the `data` tool group.
 *
 * The guard tests are the important ones: every case here is a way a write
 * could reach a database through a tool advertised as read-only — a second
 * statement after a semicolon, a data-modifying CTE, a keyword hidden by a
 * comment, `SELECT ... FOR UPDATE` taking locks.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPostgresDsn, DataQueryError, normalizeCell, runTabularQuery } from './query';
import { assertReadOnlyQuery, blankSqlLiterals, SqlGuardError } from './sql-guard';
import { inferColumnType, loadTabularFile, normalizeColumnNames } from './tabular';

const dir = mkdtempSync(join(tmpdir(), 'octipus-data-'));

function csv(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe('assertReadOnlyQuery', () => {
  it('accepts the read statements', () => {
    for (const q of [
      'SELECT 1',
      'select * from orders where id = $1',
      'WITH recent AS (SELECT * FROM orders) SELECT count(*) FROM recent',
      'EXPLAIN SELECT * FROM orders',
      'EXPLAIN ANALYZE SELECT * FROM orders',
      'SHOW search_path',
      'TABLE orders',
      'VALUES (1), (2)',
    ]) {
      expect(() => assertReadOnlyQuery(q)).not.toThrow();
    }
  });

  it('strips a trailing semicolon', () => {
    expect(assertReadOnlyQuery('SELECT 1;')).toBe('SELECT 1');
    expect(assertReadOnlyQuery('  SELECT 1  ')).toBe('SELECT 1');
  });

  it('refuses a second statement', () => {
    expect(() => assertReadOnlyQuery('SELECT 1; DROP TABLE orders'))
      .toThrow(/Only one statement per call/);
  });

  it('refuses writes and DDL', () => {
    for (const q of [
      'INSERT INTO orders VALUES (1)',
      'UPDATE orders SET total = 0',
      'DELETE FROM orders',
      'DROP TABLE orders',
      'CREATE TABLE t (a int)',
      'TRUNCATE orders',
      'GRANT ALL ON orders TO public',
      'COPY orders TO STDOUT',
      'CALL do_something()',
      'SET ROLE postgres',
      'VACUUM orders',
    ]) {
      expect(() => assertReadOnlyQuery(q), q).toThrow(SqlGuardError);
    }
  });

  it('refuses a data-modifying CTE', () => {
    // Postgres really does let a CTE write, so a "starts with WITH" check on
    // its own would have waved this through.
    expect(() => assertReadOnlyQuery(
      'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone',
    )).toThrow(/DELETE is not allowed/);
  });

  it('refuses SELECT ... FOR UPDATE', () => {
    expect(() => assertReadOnlyQuery('SELECT * FROM orders FOR UPDATE'))
      .toThrow(/UPDATE is not allowed/);
  });

  it('refuses the filesystem-reading functions', () => {
    expect(() => assertReadOnlyQuery("SELECT pg_read_file('/etc/passwd')"))
      .toThrow(/PG_READ_FILE is not allowed/);
  });

  it('is not fooled by a keyword inside a string or a comment', () => {
    // The word appears, but only as data or as prose — blanking literals first
    // is what keeps these from being false positives.
    expect(() => assertReadOnlyQuery("SELECT 'delete me' AS label")).not.toThrow();
    expect(() => assertReadOnlyQuery('SELECT 1 -- drop table orders')).not.toThrow();
    expect(() => assertReadOnlyQuery('/* update later */ SELECT 1')).not.toThrow();
    expect(() => assertReadOnlyQuery('SELECT "delete" FROM t')).not.toThrow();
  });

  it('does not treat a semicolon inside a string as a statement break', () => {
    expect(() => assertReadOnlyQuery("SELECT 'a; b' AS s")).not.toThrow();
  });

  it('does not let a comment hide a second statement', () => {
    expect(() => assertReadOnlyQuery('SELECT 1 /* x */; DELETE FROM orders'))
      .toThrow(/Only one statement per call/);
  });

  it('refuses an empty query', () => {
    expect(() => assertReadOnlyQuery('   ')).toThrow(/empty/);
  });

  it('names what it got when the head is unknown', () => {
    expect(() => assertReadOnlyQuery('MERGE INTO t USING s ON true'))
      .toThrow(SqlGuardError);
  });
});

describe('blankSqlLiterals', () => {
  it('handles nested block comments', () => {
    const out = blankSqlLiterals('/* a /* b */ c */ SELECT 1');
    expect(out.trim()).toBe('select 1');
  });

  it('handles a doubled quote inside a string', () => {
    const out = blankSqlLiterals("SELECT 'it''s fine; ok' AS s");
    expect(out).not.toContain(';');
    expect(out).toContain('select');
  });

  it('handles dollar quoting', () => {
    const out = blankSqlLiterals('SELECT $tag$ delete from t $tag$ AS s');
    expect(out).not.toContain('delete');
  });
});

describe('assertPostgresDsn', () => {
  it('accepts a postgres URL', () => {
    expect(() => assertPostgresDsn('postgres://u:p@host:5432/db')).not.toThrow();
    expect(() => assertPostgresDsn('postgresql://host/db')).not.toThrow();
  });

  it('rejects anything else with a specific message', () => {
    expect(() => assertPostgresDsn('mysql://host/db')).toThrow(DataQueryError);
    expect(() => assertPostgresDsn('')).toThrow(/empty/);
  });
});

describe('normalizeCell', () => {
  it('makes driver values JSON-safe', () => {
    expect(normalizeCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(normalizeCell(10n)).toBe('10');
    expect(normalizeCell(new Uint8Array([1, 2, 3]))).toBe('<binary 3 bytes>');
    expect(normalizeCell(undefined)).toBeNull();
    expect(normalizeCell('x')).toBe('x');
  });
});

describe('normalizeColumnNames', () => {
  it('makes headers legal, and keeps the original when it changed', () => {
    const cols = normalizeColumnNames(['Total (USD)', 'id']);
    expect(cols[0].name).toBe('total_usd');
    expect(cols[0].originalName).toBe('Total (USD)');
    expect(cols[1].originalName).toBeUndefined();
  });

  it('suffixes a duplicate rather than losing a column', () => {
    const cols = normalizeColumnNames(['Amount', 'amount', 'AMOUNT']);
    expect(cols.map((c) => c.name)).toEqual(['amount', 'amount_2', 'amount_3']);
  });

  it('names a blank header by position', () => {
    expect(normalizeColumnNames(['', null])[0].name).toBe('column_1');
    expect(normalizeColumnNames(['', null])[1].name).toBe('column_2');
  });

  it('prefixes a header that starts with a digit', () => {
    expect(normalizeColumnNames(['2026'])[0].name).toBe('c_2026');
  });
});

describe('inferColumnType', () => {
  it('narrows only when every value agrees', () => {
    expect(inferColumnType([1, 2, '3'])).toBe('numeric');
    expect(inferColumnType(['1', 'n/a'])).toBe('text');
    expect(inferColumnType(['true', 'no'])).toBe('boolean');
    expect(inferColumnType([new Date(), new Date()])).toBe('timestamp');
    expect(inferColumnType([null, ''])).toBe('text');
  });

  it('does not read punctuation as a number', () => {
    expect(inferColumnType(['-', '.'])).toBe('text');
  });
});

describe('loadTabularFile', () => {
  it('reads a CSV with a header and infers types', async () => {
    const path = csv('orders.csv', 'Region,Amount\nEMEA,10\nAPAC,20\nEMEA,5\n');
    const table = await loadTabularFile(path);
    expect(table.name).toBe('data');
    expect(table.columns.map((c) => c.name)).toEqual(['region', 'amount']);
    expect(table.columns[1].type).toBe('numeric');
    expect(table.totalRows).toBe(3);
    expect(table.truncated).toBe(false);
  });

  it('pads a ragged row so every row is the header width', async () => {
    const path = csv('ragged.csv', 'a,b,c\n1,2,3\n4\n');
    const table = await loadTabularFile(path);
    expect(table.rows[1]).toHaveLength(3);
    expect(table.rows[1][2]).toBeNull();
  });

  it('reports truncation rather than hiding it', async () => {
    const path = csv('many.csv', `n\n${Array.from({ length: 10 }, (_, i) => i).join('\n')}\n`);
    const table = await loadTabularFile(path, { maxRows: 4 });
    expect(table.rows).toHaveLength(4);
    expect(table.totalRows).toBe(10);
    expect(table.truncated).toBe(true);
  });
});

describe('runTabularQuery', () => {
  it('aggregates a CSV with SQL', async () => {
    const path = csv('sales.csv', 'Region,Amount\nEMEA,10\nAPAC,20\nEMEA,5\n');
    const table = await loadTabularFile(path);
    const result = await runTabularQuery({
      tables: [table],
      query: 'SELECT region, sum(amount) AS total FROM data GROUP BY region ORDER BY total DESC',
    });
    expect(result.columns).toEqual(['region', 'total']);
    expect(result.rows).toEqual([['APAC', 20], ['EMEA', 15]]);
    expect(result.rowCount).toBe(2);
  }, 60_000);

  it('applies the row limit and says it did', async () => {
    const path = csv('rows.csv', `n\n${Array.from({ length: 20 }, (_, i) => i).join('\n')}\n`);
    const table = await loadTabularFile(path);
    const result = await runTabularQuery({ tables: [table], query: 'SELECT n FROM data', limit: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.rowCount).toBe(20);
    expect(result.truncated).toBe(true);
  }, 60_000);

  it('refuses a write against the loaded table', async () => {
    const path = csv('guard.csv', 'a\n1\n');
    const table = await loadTabularFile(path);
    await expect(runTabularQuery({ tables: [table], query: 'DELETE FROM data' }))
      .rejects.toThrow(SqlGuardError);
  });

  it('refuses two output columns with the same name', async () => {
    const path = csv('dupe.csv', 'a,b\n1,2\n');
    const table = await loadTabularFile(path);
    await expect(runTabularQuery({ tables: [table], query: 'SELECT a AS x, b AS x FROM data' }))
      .rejects.toThrow(/both named "x"/);
  }, 60_000);
});
