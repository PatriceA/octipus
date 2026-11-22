'use client';

/**
 * A view's Table (spec §2.6): sort by column, an optional filter box, pages
 * of `pageSize`, row selection written to the `selected` path, and the live
 * row cap from the limits with a visible "showing N of M" line.
 */
import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { INLINE_UI_VIEW_LIMITS } from '../../../../../src/shared/inline-ui/limits';
import {
  formatValue,
  getPointer,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  jsonEqual,
  resolvePath,
  type TableColumn,
  toNumber,
  valueToText,
} from '../../../../../src/shared/inline-ui/view';
import { cn } from '@/lib/utils';
import { type NodeProps, useViewRuntime } from './runtime';

const ALIGN = { start: 'text-left', center: 'text-center', end: 'text-right' } as const;

/** What a cell sorts by: the number its format reads, a date's time, or its text. */
function sortKey(value: JsonValue | undefined, column: TableColumn): number | string {
  const format = column.format;
  if (format === 'date') return typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (format === 'number' || format === 'percent' || format?.startsWith('currency:')) return toNumber(value);
  if (format === undefined && typeof value === 'number') return value;
  return valueToText(value);
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') {
    // Values that are not numbers sort last either way.
    if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
    if (Number.isNaN(b)) return -1;
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

interface IndexedRow { row: JsonObject; index: number }

export function Table({ c, r, scope }: NodeProps<'Table'>) {
  const rt = useViewRuntime();
  const filterId = useId();
  const groupName = useId();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(0);

  const all = Array.isArray(r.rows) ? r.rows.filter(isJsonObject) : [];
  const capped = all.slice(0, INLINE_UI_VIEW_LIMITS.tableRows);
  const cell = (row: JsonObject, column: TableColumn) => formatValue(row[column.key], column.format, rt.format);

  const q = query.trim().toLowerCase();
  let rows: IndexedRow[] = capped.map((row, index) => ({ row, index }));
  if (q) rows = rows.filter(({ row }) => c.columns.some((col) => cell(row, col).toLowerCase().includes(q)));
  const sortColumn = sort && c.columns.find((col) => col.key === sort.key);
  if (sort && sortColumn) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => dir * compare(sortKey(a.row[sort.key], sortColumn), sortKey(b.row[sort.key], sortColumn)) || a.index - b.index);
  }
  const pageSize = typeof c.pageSize === 'number' && c.pageSize >= 1 ? Math.floor(c.pageSize) : 10;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * pageSize, (current + 1) * pageSize);

  // Selection writes the row (single) or rows (multiple) to `selected`.
  const selectable = c.selectable && c.selected ? c.selectable : null;
  const selectedPath = selectable && c.selected ? resolvePath(c.selected['@path'], scope) : null;
  const selectedValue = selectedPath ? getPointer(rt.data, selectedPath) : undefined;
  const sameRow = (a: JsonValue, b: JsonObject) => (c.rowKey ? isJsonObject(a) && jsonEqual(a[c.rowKey], b[c.rowKey]) : jsonEqual(a, b));
  const isSelected = (row: JsonObject) => selectable === 'multiple'
    ? Array.isArray(selectedValue) && selectedValue.some((s) => sameRow(s, row))
    : selectedValue !== undefined && selectedValue !== null && sameRow(selectedValue, row);
  const toggle = (row: JsonObject) => {
    if (!selectedPath) return;
    if (selectable === 'single') { rt.write(selectedPath, row); return; }
    const list = Array.isArray(selectedValue) ? selectedValue : [];
    rt.write(selectedPath, isSelected(row) ? list.filter((s) => !sameRow(s, row)) : [...list, row]);
  };
  const selectionOff = rt.readOnly || rt.inert;

  const toggleSort = (key: string) => {
    setSort((prev) => (prev?.key !== key ? { key, dir: 'asc' } : prev.dir === 'asc' ? { key, dir: 'desc' } : null));
    setPage(0);
  };

  return (
    <div className="flex flex-col gap-2 min-w-0" data-testid="inline-ui-table">
      {c.filter && (
        <div className="flex items-center gap-2">
          <label htmlFor={filterId} className="sr-only">Filter rows</label>
          <input
            id={filterId}
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            placeholder="Filter…"
            className="w-full max-w-xs rounded-md border border-outline-variant bg-surface-container-high px-2 py-1 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus:outline-none focus:border-primary"
          />
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-outline-variant/50">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-surface-container-high">
            <tr>
              {selectable && <th scope="col" className="w-8 px-2 py-1.5"><span className="sr-only">Selected</span></th>}
              {c.columns.map((col) => {
                const sorted = sort?.key === col.key ? sort.dir : null;
                const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn('px-2 py-1.5 text-xs font-medium text-on-surface-variant whitespace-nowrap', ALIGN[col.align ?? 'start'])}
                  >
                    {col.sortable === false ? col.label : (
                      <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-on-surface">
                        {col.label}<Icon className={cn('h-3 w-3', !sorted && 'opacity-40')} aria-hidden />
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={c.columns.length + (selectable ? 1 : 0)} className="px-2 py-3 text-center text-xs text-on-surface-variant">{q ? 'No rows match the filter.' : 'No rows.'}</td></tr>
            )}
            {shown.map(({ row, index }) => {
              const selected = selectable ? isSelected(row) : false;
              const label = valueToText(row[c.rowKey ?? c.columns[0]?.key ?? ''], rt.format) || `row ${index + 1}`;
              return (
                <tr key={c.rowKey ? valueToText(row[c.rowKey]) || index : index} className={cn('border-t border-outline-variant/30', selected && 'bg-primary-container/40')}>
                  {selectable && (
                    <td className="px-2 py-1.5">
                      <input
                        type={selectable === 'single' ? 'radio' : 'checkbox'}
                        name={selectable === 'single' ? groupName : undefined}
                        checked={selected}
                        disabled={selectionOff}
                        onChange={() => toggle(row)}
                        aria-label={`Select ${label}`}
                        className="accent-primary"
                      />
                    </td>
                  )}
                  {c.columns.map((col) => (
                    <td key={col.key} className={cn('px-2 py-1.5 text-on-surface align-top', ALIGN[col.align ?? 'start'], col.format && col.format !== 'text' ? 'tabular-nums whitespace-nowrap' : 'min-w-[9rem]')}>
                      {cell(row, col)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(pages > 1 || all.length > capped.length || q) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
          <span data-testid="inline-ui-table-count">
            {rows.length === 0 ? 'No rows shown' : `Showing ${current * pageSize + 1}–${current * pageSize + shown.length} of ${rows.length}`}
            {all.length > capped.length && ` (the first ${capped.length} of ${all.length} rows)`}
          </span>
          {pages > 1 && (
            <span className="ml-auto flex items-center gap-1">
              <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className="rounded-md border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-container-high disabled:opacity-40">Previous</button>
              <span className="tabular-nums">Page {current + 1} of {pages}</span>
              <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} className="rounded-md border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-container-high disabled:opacity-40">Next</button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
