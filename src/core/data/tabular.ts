/**
 * Reading a workspace data file into something SQL can be run over.
 *
 * SheetJS is already a dependency (the document processor extracts
 * spreadsheets with it) and it parses CSV and TSV as well as XLSX, so one
 * reader covers all three formats without adding a CSV library.
 *
 * The output is deliberately positional (`columns` + `rows` as arrays) rather
 * than an array of objects: the next step loads it into a table, and a
 * duplicated or blank header must be resolved once, here, not guessed at again
 * by every consumer.
 */

/** Column types this reader infers. Everything unrecognised stays `text`. */
export type ColumnType = 'numeric' | 'boolean' | 'timestamp' | 'text';

export interface TableColumn {
  /** Header name, normalised to be unique and non-empty. */
  name: string;
  /** Original header text, when normalisation changed it. */
  originalName?: string;
  type: ColumnType;
}

export interface LoadedTable {
  /** Table name the rows are loaded under. */
  name: string;
  columns: TableColumn[];
  rows: unknown[][];
  /** Rows read from the file, before any cap was applied. */
  totalRows: number;
  /** True when `rows` was cut short by `maxRows`. */
  truncated: boolean;
  /** Sheet the rows came from (spreadsheets only). */
  sheet?: string;
  /** Every sheet in the workbook, so a caller can pick a different one. */
  sheets?: string[];
}

/**
 * Row and column ceilings. A workspace file is user data, not a database, and
 * the whole table is materialised in memory and then again inside an embedded
 * Postgres — so the limits are low enough that a mistakenly huge file fails
 * fast with a message instead of exhausting the process.
 */
export const MAX_TABLE_ROWS = 100_000;
export const MAX_TABLE_COLUMNS = 200;

export class TabularError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TabularError';
  }
}

const SUPPORTED_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm', '.xls'];

/** Whether this reader can be expected to make sense of the file. */
export function isTabularFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Turn a header cell into a legal, unique, non-empty identifier.
 *
 * Names are lowercased and non-alphanumerics collapse to underscores so a
 * header like "Total (USD)" is addressable as `total_usd` without quoting.
 * Collisions get a numeric suffix rather than silently overwriting, because a
 * spreadsheet with two "Amount" columns is common and losing one of them
 * quietly is the worst possible outcome.
 */
export function normalizeColumnNames(headers: unknown[]): TableColumn[] {
  const used = new Map<string, number>();
  return headers.map((raw, index) => {
    const original = raw == null ? '' : String(raw).trim();
    let name = original
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (name.length === 0) name = `column_${index + 1}`;
    if (/^[0-9]/.test(name)) name = `c_${name}`;
    name = name.slice(0, 63);

    const seen = used.get(name);
    if (seen === undefined) {
      used.set(name, 1);
    } else {
      used.set(name, seen + 1);
      name = `${name}_${seen + 1}`;
    }

    const column: TableColumn = { name, type: 'text' };
    if (original.length > 0 && original !== name) column.originalName = original;
    return column;
  });
}

/**
 * Infer one column's type from its values.
 *
 * A column is only narrowed when *every* non-empty value agrees. One stray
 * "n/a" in a numeric column makes the whole column text, which is the honest
 * answer: silently coercing it to NULL would make `avg()` quietly wrong.
 */
export function inferColumnType(values: unknown[]): ColumnType {
  let seen = 0;
  let numeric = 0;
  let boolish = 0;
  let dates = 0;

  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    seen++;

    if (value instanceof Date) { dates++; numeric++; continue; }
    if (typeof value === 'number') { if (Number.isFinite(value)) numeric++; continue; }
    if (typeof value === 'boolean') { boolish++; continue; }

    const text = String(value).trim();
    if (/^(true|false|yes|no)$/i.test(text)) { boolish++; continue; }
    // Anchored, and rejecting a bare "-" or "." so punctuation is not a number.
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) numeric++;
  }

  if (seen === 0) return 'text';
  if (dates === seen) return 'timestamp';
  if (boolish === seen) return 'boolean';
  if (numeric === seen) return 'numeric';
  return 'text';
}

/**
 * Read a CSV / TSV / XLSX file into a single table.
 *
 * The first row is the header. `sheet` picks a worksheet by name; without it
 * the first sheet wins and every sheet name is reported back so the caller can
 * ask again.
 */
export async function loadTabularFile(
  filePath: string,
  options: { sheet?: string; table?: string; maxRows?: number } = {},
): Promise<LoadedTable> {
  const maxRows = Math.min(options.maxRows ?? MAX_TABLE_ROWS, MAX_TABLE_ROWS);
  const { readFile } = await import('node:fs/promises');
  const XLSX = await import('xlsx');

  const buffer = await readFile(filePath);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = workbook.SheetNames;
  if (sheets.length === 0) {
    throw new TabularError(`${filePath} has no sheets or rows`);
  }

  const sheetName = options.sheet ?? sheets[0];
  if (options.sheet && !sheets.includes(options.sheet)) {
    throw new TabularError(
      `Sheet "${options.sheet}" not found. Available sheets: ${sheets.join(', ')}`,
    );
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new TabularError(`Sheet "${sheetName}" is empty`);

  // `defval: null` keeps blank cells as NULL rather than the empty string, so
  // an empty numeric cell stays numeric instead of dragging the column to text.
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: null,
  });
  if (grid.length === 0) {
    throw new TabularError(`${filePath} (sheet "${sheetName}") has no rows`);
  }

  const header = Array.isArray(grid[0]) ? grid[0] : [];
  if (header.length === 0) {
    throw new TabularError(`${filePath} (sheet "${sheetName}") has no header row`);
  }
  if (header.length > MAX_TABLE_COLUMNS) {
    throw new TabularError(
      `Too many columns: ${header.length} (limit ${MAX_TABLE_COLUMNS})`,
    );
  }

  const columns = normalizeColumnNames(header);
  const body = grid.slice(1);
  const totalRows = body.length;
  const rows = body.slice(0, maxRows).map((row) => {
    const cells = Array.isArray(row) ? row : [];
    // Pad short rows so every row is the same width as the header — a ragged
    // CSV would otherwise produce an INSERT with the wrong arity.
    return columns.map((_, i) => (i < cells.length ? cells[i] : null));
  });

  for (let i = 0; i < columns.length; i++) {
    columns[i].type = inferColumnType(rows.map((row) => row[i]));
  }

  const result: LoadedTable = {
    name: options.table ?? 'data',
    columns,
    rows,
    totalRows,
    truncated: totalRows > rows.length,
    sheet: sheetName,
  };
  if (sheets.length > 1) result.sheets = sheets;
  return result;
}
