/**
 * The two query engines behind the `data` tool group.
 *
 * `runPostgresQuery` opens a short-lived connection to a database the user has
 * stored in the vault and runs one statement inside a read-only transaction.
 * `runTabularQuery` loads a workspace file into a throwaway in-process Postgres
 * (PGlite, already a dependency as the embedded storage backend) and runs the
 * statement there — so both tools speak the same SQL dialect, and neither
 * needed a new engine dependency.
 */
import { assertReadOnlyQuery } from './sql-guard';
import type { LoadedTable } from './tabular';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** Rows returned by the database, before `limit` was applied. */
  rowCount: number;
  /** True when `rows` was cut short by `limit`. */
  truncated: boolean;
  elapsedMs: number;
}

/** Result rows past this are never returned, whatever `limit` asks for. */
export const MAX_RESULT_ROWS = 5000;
export const DEFAULT_RESULT_ROWS = 200;
/** Upper bound on a query's server-side runtime. */
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export class DataQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataQueryError';
  }
}

/**
 * Reject anything that is not a PostgreSQL DSN.
 *
 * The connection string comes from the vault rather than from the model, so
 * this is not a trust boundary — it is a better error than the driver's, which
 * for a MySQL URL is an opaque parse failure.
 */
export function assertPostgresDsn(dsn: string): void {
  if (typeof dsn !== 'string' || dsn.trim().length === 0) {
    throw new DataQueryError('The stored connection string is empty');
  }
  if (!/^postgres(ql)?:\/\//i.test(dsn.trim())) {
    throw new DataQueryError(
      'Only PostgreSQL connections are supported — the stored value is not a postgres:// URL',
    );
  }
}

/**
 * Column names for the result grid, refusing duplicates.
 *
 * Rows arrive from the driver as objects, so two output columns with the same
 * name would collapse into one and the grid would silently lose a column.
 * Saying so is better than returning a table that is quietly wrong.
 */
function resultColumns(names: string[]): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new DataQueryError(
        `Two output columns are both named "${name}" — alias one of them (e.g. SELECT a.id AS a_id)`,
      );
    }
    seen.add(name);
  }
  return names;
}

/**
 * Make a driver value safe to put in a tool result.
 *
 * Dates become ISO strings and bigints become decimal strings because neither
 * survives `JSON.stringify` usefully; a bytea column is reported by size
 * rather than dumped, since a model can do nothing with the bytes and they
 * would swamp the context.
 */
export function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  return value;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RESULT_ROWS;
  return Math.max(1, Math.min(Math.floor(limit), MAX_RESULT_ROWS));
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS));
}

function grid(rows: Record<string, unknown>[], columns: string[], limit: number): QueryResult {
  const kept = rows.slice(0, limit);
  return {
    columns,
    rows: kept.map((row) => columns.map((name) => normalizeCell(row[name]))),
    rowCount: rows.length,
    truncated: rows.length > kept.length,
    elapsedMs: 0,
  };
}

/**
 * Run one read-only statement against an external PostgreSQL database.
 *
 * The transaction is the real guard: `SET TRANSACTION READ ONLY` makes the
 * server refuse a write even if the lexical check in `sql-guard` were wrong,
 * and `SET LOCAL statement_timeout` bounds a runaway scan. Both are `LOCAL` to
 * the transaction, and the connection is closed either way.
 */
export async function runPostgresQuery(input: {
  dsn: string;
  query: string;
  params?: unknown[];
  limit?: number;
  timeoutMs?: number;
}): Promise<QueryResult> {
  assertPostgresDsn(input.dsn);
  const statement = assertReadOnlyQuery(input.query);
  const limit = clampLimit(input.limit);
  const timeoutMs = clampTimeout(input.timeoutMs);

  const { default: postgres } = await import('postgres');
  const sql = postgres(input.dsn.trim(), {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 5,
    // Prepared statements are pointless for a one-shot connection and break
    // against poolers (pgbouncer in transaction mode) that a user is likely to
    // have put the DSN behind.
    prepare: false,
    onnotice: () => { /* a NOTICE is not this tool's business */ },
  });

  const started = Date.now();
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      // `timeoutMs` is clamped to an integer above, so interpolating it is
      // safe; `SET LOCAL` does not accept a bind parameter.
      await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      return tx.unsafe(statement, (input.params ?? []) as never[]);
    }) as unknown as Record<string, unknown>[] & { columns?: { name: string }[] };

    const names = resultColumns(
      rows.columns?.map((c) => c.name) ?? (rows.length > 0 ? Object.keys(rows[0]) : []),
    );
    const result = grid(rows as Record<string, unknown>[], names, limit);
    result.elapsedMs = Date.now() - started;
    return result;
  } finally {
    // Never let a hung teardown mask the query's own outcome.
    await sql.end({ timeout: 5 }).catch(() => { /* connection already gone */ });
  }
}

/** Quote an identifier for interpolation into DDL. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const PG_TYPES: Record<string, string> = {
  numeric: 'double precision',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  text: 'text',
};

/**
 * Coerce a spreadsheet cell to something the inferred column type accepts.
 *
 * Inference only narrows a column when every value agrees, so a value that
 * does not convert here is a blank or a null — anything else would have made
 * the column text.
 */
function bindValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (type === 'numeric') {
    const n = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    return /^(true|yes)$/i.test(String(value).trim());
  }
  if (type === 'timestamp') {
    if (value instanceof Date) return value.toISOString();
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return String(value);
}

/**
 * Run one read-only statement over tables loaded from workspace files.
 *
 * Each call gets its own in-memory PGlite instance, created and closed inside
 * this function: nothing survives the query, so a file loaded for one user can
 * never be read by the next call.
 */
export async function runTabularQuery(input: {
  tables: LoadedTable[];
  query: string;
  limit?: number;
}): Promise<QueryResult> {
  if (input.tables.length === 0) {
    throw new DataQueryError('No table was loaded');
  }
  const statement = assertReadOnlyQuery(input.query);
  const limit = clampLimit(input.limit);

  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create({});
  const started = Date.now();

  try {
    for (const table of input.tables) {
      const columns = table.columns
        .map((c) => `${quoteIdent(c.name)} ${PG_TYPES[c.type] ?? 'text'}`)
        .join(', ');
      await db.exec(`CREATE TABLE ${quoteIdent(table.name)} (${columns});`);

      if (table.rows.length === 0) continue;
      const colList = table.columns.map((c) => quoteIdent(c.name)).join(', ');
      // Batched multi-row INSERTs: one statement per row would spend more time
      // in round-trips than in the query the user actually asked for.
      const BATCH = 500;
      for (let start = 0; start < table.rows.length; start += BATCH) {
        const chunk = table.rows.slice(start, start + BATCH);
        const values: unknown[] = [];
        const tuples = chunk.map((row) => {
          const placeholders = table.columns.map((column, i) => {
            values.push(bindValue(row[i], column.type));
            return `$${values.length}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        await db.query(
          `INSERT INTO ${quoteIdent(table.name)} (${colList}) VALUES ${tuples.join(', ')}`,
          values,
        );
      }
    }

    const res = await db.query<Record<string, unknown>>(statement);
    const names = resultColumns(
      res.fields?.map((f) => f.name) ?? (res.rows.length > 0 ? Object.keys(res.rows[0]) : []),
    );
    const result = grid(res.rows, names, limit);
    result.elapsedMs = Date.now() - started;
    return result;
  } finally {
    await db.close().catch(() => { /* throwaway instance */ });
  }
}
