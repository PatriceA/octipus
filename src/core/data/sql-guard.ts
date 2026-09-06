/**
 * Read-only SQL admission control for the `data` tool group.
 *
 * Two layers guard `sql_query`, and this is the outer one: a lexical check that
 * the statement is a single read. The inner one is the server — every query
 * runs inside `BEGIN; SET TRANSACTION READ ONLY` under a statement timeout, so
 * a write that somehow slipped past this parser still fails at the database.
 *
 * The parser exists for the error message. "Only one statement per call" is
 * something a model can act on; `25006 cannot execute INSERT in a read-only
 * transaction` arrives a round-trip later and reads like a bug in the tool.
 */

/** Statement keywords a read-only query may start with. */
const ALLOWED_HEADS = ['select', 'with', 'explain', 'show', 'table', 'values'] as const;

/**
 * Keywords that make a statement a write, a DDL, or a session mutation.
 * Matched as whole words *after* strings, comments and quoted identifiers have
 * been blanked, so a column named "delete" (which has to be quoted to be legal
 * anyway) does not trip the scan.
 *
 * `analyze` is here because `EXPLAIN ANALYZE` executes the plan it reports on;
 * it is allowed back in only when the statement starts with EXPLAIN, where the
 * read-only transaction still bounds what that execution can do.
 *
 * The file-reading functions are listed because a read-only transaction does
 * not stop them: `pg_read_file` on a superuser connection is a filesystem
 * escape, and `lo_import` / `lo_export` are the large-object equivalents.
 */
const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge',
  'drop', 'alter', 'create', 'truncate',
  'grant', 'revoke',
  'copy', 'call', 'do', 'execute', 'prepare', 'deallocate',
  'vacuum', 'analyze', 'reindex', 'cluster', 'refresh', 'checkpoint',
  'lock', 'set', 'reset', 'discard',
  'begin', 'commit', 'rollback', 'savepoint',
  'listen', 'notify', 'unlisten',
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export',
];

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlGuardError';
  }
}

/**
 * Blank out every region a keyword scan must not look inside — line comments,
 * block comments, single-quoted strings, dollar-quoted strings and
 * double-quoted identifiers — replacing each with spaces so offsets and token
 * boundaries survive. Newlines are kept so a `--` comment still ends.
 *
 * Returned lowercased, ready to scan.
 */
export function blankSqlLiterals(query: string): string {
  const out = query.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < query.length) {
    const two = query.slice(i, i + 2);

    if (two === '--') {
      const nl = query.indexOf('\n', i);
      const stop = nl === -1 ? query.length : nl;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === '/*') {
      // Postgres block comments nest, so count depth rather than stopping at
      // the first `*/` — `/* a /* b */ still a comment */` is one comment, and
      // treating it as two would leave live SQL blanked and dead SQL scanned.
      let depth = 1;
      let k = i + 2;
      while (k < query.length && depth > 0) {
        if (query.slice(k, k + 2) === '/*') { depth++; k += 2; continue; }
        if (query.slice(k, k + 2) === '*/') { depth--; k += 2; continue; }
        k++;
      }
      blank(i, k);
      i = k;
      continue;
    }

    const ch = query[i];

    if (ch === "'" || ch === '"') {
      let k = i + 1;
      while (k < query.length) {
        if (query[k] === ch) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (query[k + 1] === ch) { k += 2; continue; }
          k++;
          break;
        }
        k++;
      }
      blank(i, k);
      i = k;
      continue;
    }

    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(query.slice(i));
      if (tag) {
        const marker = tag[0];
        const end = query.indexOf(marker, i + marker.length);
        const stop = end === -1 ? query.length : end + marker.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    i++;
  }

  return out.join('').toLowerCase();
}

/**
 * Reject anything that is not a single read-only statement.
 *
 * Returns the statement with a trailing semicolon stripped, so callers can pass
 * the result straight to the driver. Throws `SqlGuardError` with a message
 * written for a model that has to fix its own call.
 */
export function assertReadOnlyQuery(query: string): string {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new SqlGuardError('Query is empty');
  }

  const scan = blankSqlLiterals(query);

  // One statement only. A single trailing semicolon is normal and allowed;
  // anything after it is a second statement, which is how a read tool would
  // become a write tool.
  const semi = scan.indexOf(';');
  if (semi !== -1 && scan.slice(semi + 1).trim().length > 0) {
    throw new SqlGuardError(
      'Only one statement per call — remove everything after the first semicolon',
    );
  }

  const head = /[a-z_]+/.exec(scan.trim())?.[0] ?? '';
  if (!ALLOWED_HEADS.includes(head as (typeof ALLOWED_HEADS)[number])) {
    throw new SqlGuardError(
      `Read-only queries only: the statement must start with ${ALLOWED_HEADS.join(', ').toUpperCase()} (got ${head ? head.toUpperCase() : 'nothing recognisable'})`,
    );
  }

  const isExplain = head === 'explain';
  for (const word of FORBIDDEN) {
    // EXPLAIN ANALYZE is a read of a read, and a data engineer asking why a
    // query is slow has no other way to find out.
    if (isExplain && word === 'analyze') continue;
    const re = new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`);
    if (re.test(scan)) {
      throw new SqlGuardError(
        `Read-only queries only: ${word.toUpperCase()} is not allowed. Use SELECT / WITH / EXPLAIN / SHOW.`,
      );
    }
  }

  return semi === -1 ? query.trim() : query.slice(0, semi).trim();
}
