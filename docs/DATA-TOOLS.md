# Data Tools

Read-only SQL, for the `data` role. Two tools in one group:

| Tool | What it does |
|---|---|
| `list_connections` | Names the database connections this user has registered. |
| `sql_query` | Runs one read-only statement against one of those connections. |
| `csv_query` | Runs SQL over a CSV, TSV or spreadsheet in the workspace. |

Before this, the `data` role could design a query but not run one — its
prompt sent it to `shell` and `psql`, which is neither auditable nor safe.

## Registering a connection

`sql_query` never takes a connection string. It takes the **name** of a vault
entry, and only entries tagged `database` resolve:

```bash
curl -X POST http://localhost:3005/api/vault \
  -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "analytics",
        "value": "postgres://reader:pw@db.internal:5432/analytics",
        "credentialType": "other",
        "description": "Analytics replica (read-only role)",
        "tags": ["database"]
      }'
```

The tag is the authorisation boundary, and it is deliberate. Without it an
agent could name any secret the user holds — a Stripe key, an OAuth token —
and have the tool try to open it as a database. With it, the set of databases
an agent can reach is exactly the set the user chose to expose, and adding one
is an explicit act.

Narrow further if you want to: a vault entry's `allowedTools` list pins a
secret to named tools, so `["data"]` means nothing else can resolve it at all.

Use a database role that is read-only at the server too. The tool is read-only
by construction, but defence in depth is cheap and a connection string is a
connection string.

## What "read-only" means here

Two independent layers, because one of them is a parser and parsers are
wrong eventually.

**The statement guard** (`src/core/data/sql-guard.ts`) blanks out comments,
string literals, dollar-quoted blocks and quoted identifiers, then checks what
is left. A statement must start with `SELECT`, `WITH`, `EXPLAIN`, `SHOW`,
`TABLE` or `VALUES`, and must contain no write, DDL, or session-mutating
keyword anywhere. That last part is not paranoia: PostgreSQL allows a
data-modifying CTE, so `WITH gone AS (DELETE FROM orders RETURNING *) SELECT *
FROM gone` starts with `WITH` and deletes your orders. Anything after the
first semicolon is refused as a second statement. `pg_read_file` and the
large-object import/export functions are refused too — a read-only transaction
does not stop them, and on a superuser connection they are a filesystem
escape.

`EXPLAIN ANALYZE` is allowed, because a data engineer asking why a query is
slow has no other way to find out, and the plan it runs is still bound by the
transaction below.

**The transaction** is the layer that actually enforces it. Every query runs
inside `BEGIN; SET TRANSACTION READ ONLY` with `SET LOCAL statement_timeout`,
on a connection opened for that one call and closed in a `finally`. A write
that somehow got past the parser is refused by the server.

The parser exists for the error message. "Only one statement per call" is
something a model can act on; `25006 cannot execute INSERT in a read-only
transaction` arrives a round-trip later and reads like a bug in the tool.

## sql_query

```
sql_query { connection, query, params?, limit?, timeout_ms? }
  → { columns, rows, rowCount, truncated, elapsedMs }
```

PostgreSQL only — the DSN must be a `postgres://` URL, and anything else is
refused by name rather than by an opaque driver parse error.

Pass values as `params` with `$1` placeholders. Rows come back as a column
list plus positional rows, which is compact; two output columns with the same
name are refused with a message telling the model to alias one, because
collapsing them would silently lose a column.

Defaults: 200 rows (max 5000), 30s statement timeout (max 120s). Dates become
ISO strings, bigints become decimal strings, and a `bytea` column is reported
by size rather than dumped into the model's context.

## csv_query

```
csv_query { path, query?, table?, sheet?, limit? }
  → the file's schema, or { columns, rows, rowCount, truncated }
```

Called **without** a query it returns the column names, inferred types, row
count and a few sample rows. That is the intended first call: a model that has
not seen the header cannot write a correct query, and one round-trip here
beats three failed ones.

The path is resolved through the same `WorkspaceFS` sandbox the filesystem
tool uses, so traversal and symlink escapes are refused and each user sees
only their own workspace. `.csv`, `.tsv`, `.txt`, `.xls`, `.xlsx` and `.xlsm`
are all read by SheetJS, which the document processor already depends on.

Rows are loaded into a throwaway in-memory PGlite instance — the embedded
storage backend, already a dependency — and the statement runs there. So it is
real PostgreSQL: CTEs, window functions and `date_trunc` all work, and it is
the same dialect as `sql_query`, rather than a second one to learn. Nothing
survives the call: the instance is created and closed inside it, so one user's
file can never be read by the next.

Column names are normalised (`Total (USD)` becomes `total_usd`) and duplicates
are suffixed rather than dropped — a spreadsheet with two `Amount` columns is
common and losing one quietly is the worst outcome. A column is typed as
numeric, boolean or timestamp only when **every** non-empty value agrees; one
stray `n/a` makes the column text, because silently coercing it to NULL would
make `avg()` quietly wrong.

Limits: 100,000 rows and 200 columns, reported as `sourceTruncated` rather
than silently cut.

## Getting the answer out as a file

Put the result in a markdown table and call
`documents.export_document` with `format: "xlsx"` — each table becomes a
sheet. See [DOCUMENTS.md](DOCUMENTS.md#exporting-a-deliverable).

## Key files

| Path | What |
|---|---|
| `src/tools/data/index.ts` | The tool group; vault lookup and workspace sandboxing |
| `src/core/data/sql-guard.ts` | Statement admission control |
| `src/core/data/query.ts` | The read-only transaction, and the PGlite path |
| `src/core/data/tabular.ts` | Reading a CSV / spreadsheet into a typed table |
