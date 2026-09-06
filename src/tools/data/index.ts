import { DataQueryError, runPostgresQuery, runTabularQuery } from '@/core/data/query';
import { SqlGuardError } from '@/core/data/sql-guard';
import { isTabularFile, loadTabularFile, TabularError } from '@/core/data/tabular';
import type { AgentContext, ToolManifest } from '@/core/types';
import { getVault } from '@/security/vault';
import { WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * The tag a vault entry must carry to be usable as a database connection.
 *
 * This is the authorisation boundary for `sql_query`. The model names a
 * connection, never a DSN, and only entries the user deliberately tagged are
 * resolvable — so an agent cannot point the query tool at an API key, and
 * cannot reach a database the user did not mean to expose to it.
 */
export const CONNECTION_TAG = 'database';

/** Ceiling on the serialized result, so one wide query cannot fill the context. */
const MAX_RESULT_CHARS = 200_000;

export interface ConnectionEntry {
  name: string;
  description: string | null;
  scope: string;
}

/**
 * Vault entries tagged as database connections, user scope first.
 *
 * System-scope entries are included because an operator may register a shared
 * warehouse once for everyone; `Vault.getForAgent` resolves in the same order,
 * so what is listed here is exactly what `sql_query` can open.
 */
export async function listConnections(
  userId: string,
  workspaceId: string | null,
): Promise<ConnectionEntry[]> {
  const vault = getVault();
  const scopes = await Promise.all([
    vault.list(userId, { workspaceId }),
    vault.list('system'),
  ]);

  const seen = new Set<string>();
  const found: ConnectionEntry[] = [];
  for (const entries of scopes) {
    for (const entry of entries) {
      if (!entry.tags?.includes(CONNECTION_TAG)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      found.push({ name: entry.name, description: entry.description ?? null, scope: entry.scope });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Trim a result grid until it fits the context budget, reporting the cut. */
function capResult<T extends { rows: unknown[][]; truncated: boolean }>(result: T): T {
  while (result.rows.length > 0 && JSON.stringify(result.rows).length > MAX_RESULT_CHARS) {
    // Halving converges in a handful of passes even for a very wide grid,
    // where dropping one row at a time would re-serialize thousands of times.
    result.rows = result.rows.slice(0, Math.floor(result.rows.length / 2));
    result.truncated = true;
  }
  return result;
}

/**
 * Read and analyse data: SQL against a database the user has registered, and
 * SQL against a spreadsheet or CSV in their workspace.
 *
 * Both paths are read-only by construction — see `core/data/sql-guard.ts` for
 * the statement check and `core/data/query.ts` for the read-only transaction
 * that backs it up.
 */
export class DataTool extends BaseTool {
  readonly id = 'data';
  readonly name = 'Data';
  readonly version = '1.0.0';
  readonly description = 'Run read-only SQL against a registered database, or against a CSV / spreadsheet in the workspace.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'query', description: 'Run read-only SQL against a registered database connection', defaultLevel: 'ALLOW' },
        { action: 'read', description: 'Read and query CSV / spreadsheet files in the workspace', defaultLevel: 'ALLOW' },
        { action: 'list', description: 'List the database connections registered for this user', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'list_connections', description: 'List the database connections available to this user', parameters: {}, returns: 'Connection names and descriptions' },
        { name: 'sql_query', description: 'Run one read-only SQL statement against a registered connection', parameters: { connection: { type: 'string', description: 'Connection name', required: true }, query: { type: 'string', description: 'A single SELECT / WITH / EXPLAIN statement', required: true } }, returns: 'Columns and rows' },
        { name: 'csv_query', description: 'Run read-only SQL over a CSV or spreadsheet in the workspace', parameters: { path: { type: 'string', description: 'Workspace-relative file path', required: true } }, returns: 'The file schema, or the query result' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_connections',
      `List the database connections this user has registered. A connection is a vault secret holding a PostgreSQL connection string, tagged "${CONNECTION_TAG}". Call this before sql_query rather than guessing a name.`,
      createParameterSchema({}),
      async (_args, context) => {
        const userId = this.requireUser(context);
        const connections = await listConnections(userId, context.workspaceId ?? null);
        if (connections.length === 0) {
          return {
            connections: [],
            hint: `No database connections are registered. The user can add one by storing a postgres:// URL in the vault with the tag "${CONNECTION_TAG}".`,
          };
        }
        return { connections };
      },
      { permissionAction: 'list' },
    );

    this.registerTool(
      'sql_query',
      'Run ONE read-only SQL statement against a registered database and return the rows. Reads only: the statement must be a SELECT, WITH, EXPLAIN, SHOW, TABLE or VALUES, and it runs inside a read-only transaction, so INSERT / UPDATE / DDL will be refused. Pass the connection NAME from list_connections, never a connection string. Use $1, $2 placeholders and `params` rather than pasting values into the SQL.',
      createParameterSchema({
        connection: { type: 'string', description: 'Connection name from list_connections', required: true },
        query: { type: 'string', description: 'One read-only SQL statement', required: true },
        params: { type: 'array', description: 'Values for the $1, $2 placeholders in the query', items: { type: 'string' } },
        limit: { type: 'number', description: 'Maximum rows to return (default 200, max 5000)', default: 200 },
        timeout_ms: { type: 'number', description: 'Server-side statement timeout in milliseconds (default 30000, max 120000)', default: 30000 },
      }),
      async (args, context) => {
        const userId = this.requireUser(context);
        const name = String(args.connection ?? '').trim();

        const connections = await listConnections(userId, context.workspaceId ?? null);
        if (!connections.some((c) => c.name === name)) {
          return {
            error: connections.length === 0
              ? `No database connections are registered. Store a postgres:// URL in the vault tagged "${CONNECTION_TAG}" first.`
              : `Unknown connection "${name}". Available: ${connections.map((c) => c.name).join(', ')}`,
          };
        }

        const dsn = await getVault().getForAgent(
          { userId, toolId: this.id, agentId: context.id },
          name,
        );
        if (dsn === null) {
          // Listed but unreadable means the vault entry's own allowlist
          // excludes this tool or agent — a real answer, not a missing secret.
          return { error: `Connection "${name}" is not readable by this tool. Check the secret's allowed tools.` };
        }

        try {
          const result = await runPostgresQuery({
            dsn,
            query: String(args.query ?? ''),
            params: Array.isArray(args.params) ? args.params : [],
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          });
          return { connection: name, ...capResult(result) };
        } catch (error) {
          return { error: this.explain(error) };
        }
      },
      { permissionAction: 'query' },
    );

    this.registerTool(
      'csv_query',
      'Run read-only SQL over a CSV, TSV or spreadsheet file in the workspace. The rows are loaded into a temporary table (named `data` unless you set `table`) and the statement runs against it in PostgreSQL SQL. Call it WITHOUT a query first to see the column names and inferred types, then again with the query.',
      createParameterSchema({
        path: { type: 'string', description: 'Path to the file, relative to the workspace', required: true },
        query: { type: 'string', description: 'One read-only SQL statement over the table. Omit to inspect the schema instead.' },
        table: { type: 'string', description: 'Name the loaded table (default "data")', default: 'data' },
        sheet: { type: 'string', description: 'Worksheet name, for a multi-sheet spreadsheet' },
        limit: { type: 'number', description: 'Maximum rows to return (default 200, max 5000)', default: 200 },
      }),
      async (args, context) => {
        const path = String(args.path ?? '');
        let resolved: string;
        try {
          const fs = WorkspaceFS.forAgent(context, this.extraPrefixes(context));
          fs.ensureRootSync();
          resolved = fs.resolve(path);
        } catch (error) {
          if (error instanceof WorkspaceFsError) {
            return { error: `Path "${path}" is outside the allowed workspace directories` };
          }
          throw error;
        }

        if (!isTabularFile(resolved)) {
          return { error: `${path} is not a CSV, TSV or spreadsheet — csv_query reads .csv, .tsv, .txt, .xls, .xlsx and .xlsm` };
        }

        try {
          const table = await loadTabularFile(resolved, {
            sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
            table: this.tableName(args.table),
          });

          const query = typeof args.query === 'string' ? args.query.trim() : '';
          if (query.length === 0) {
            // Schema mode. A model that has not seen the header cannot write a
            // correct query, and one round-trip here beats three failed ones.
            return {
              path,
              table: table.name,
              sheet: table.sheet,
              sheets: table.sheets,
              rows: table.totalRows,
              truncated: table.truncated,
              columns: table.columns,
              sample: table.rows.slice(0, 5).map((row) => row.map((cell) => (cell instanceof Date ? cell.toISOString() : cell))),
              hint: `Call csv_query again with a query, e.g. SELECT * FROM ${table.name} LIMIT 10`,
            };
          }

          const result = await runTabularQuery({
            tables: [table],
            query,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          return {
            path,
            table: table.name,
            sourceRows: table.totalRows,
            sourceTruncated: table.truncated,
            ...capResult(result),
          };
        } catch (error) {
          return { error: this.explain(error) };
        }
      },
      { permissionAction: 'read' },
    );
  }

  /** Every query is per-user; without an identity there is no vault and no workspace. */
  private requireUser(context: AgentContext): string {
    if (!context.userId) {
      throw new Error('data tools require an authenticated user context');
    }
    return context.userId;
  }

  private extraPrefixes(context: AgentContext): { extraAllowedPrefixes: string[] } {
    const projectPath = (context.metadata as Record<string, unknown> | undefined)?.projectPath;
    return { extraAllowedPrefixes: typeof projectPath === 'string' ? [projectPath] : [] };
  }

  /** A table name is interpolated into DDL, so keep it to something plain. */
  private tableName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (name.length === 0) return 'data';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
      throw new DataQueryError(
        `Invalid table name "${name}" — use letters, digits and underscores, starting with a letter`,
      );
    }
    return name;
  }

  /**
   * Turn an error into something the model can act on.
   *
   * The three own error classes carry messages written for exactly that, so
   * they pass through; anything else is a driver or filesystem fault and keeps
   * its own message, which is usually the database's.
   */
  private explain(error: unknown): string {
    if (error instanceof SqlGuardError || error instanceof DataQueryError || error instanceof TabularError) {
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

export const dataTool = new DataTool();
