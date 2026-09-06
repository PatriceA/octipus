/**
 * A backlog in one call. The pm role decomposes work into phases, tasks,
 * dependencies and estimates; this is where that decomposition lands on the
 * to-do list as structured rows instead of a markdown table nobody parses.
 *
 * The item shape is the pipeline plan's `{ title, detail }` (see
 * tools/plan) with the fields a backlog needs on top: `category` (a phase),
 * `estimate`, `priority`, `dueAt`, `blockedBy` and `children`. Dependencies
 * are named the way a plan names them — by the other item's title, by its
 * `#n` position in the list, or by the id of a task that already exists —
 * and resolved here, once, before anything is written.
 *
 * `parseBacklog` is pure and fully validating; `addBacklog` only writes what
 * parsing accepted. A reference that resolves to nothing is an error for the
 * whole batch, not a silently dropped edge.
 */
import { scopedRepos } from '@/db/repositories/scoped';
import type { Task, TaskSourceRef } from '@/db/schema/tasks';
import type { Principal } from '@/security/principal';
import { dateOnlyToEndOfDay } from './rank';
import { normalizeEstimate } from './structure';
import { resolveUserTimezone } from './timezone';

const TITLE_MAX = 500;
const NOTES_MAX = 10_000;
const CATEGORY_MAX = 100;
const MAX_ITEMS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One backlog item as parsed: flat, with links expressed as list positions. */
export interface BacklogItem {
  /** 1-based position in the flattened list — what `#n` references mean. */
  index: number;
  title: string;
  notes: string | null;
  category: string | null;
  estimate: string | null;
  priority: number;
  dueAt: string | null;
  /** Index of the parent item, or null for a top-level item. */
  parentIndex: number | null;
  /** Indexes of items in this batch that block this one. */
  blockedByIndexes: number[];
  /** Ids of already existing tasks that block this one (ownership is checked at write time). */
  blockedByIds: string[];
}

export type ParsedBacklog = { ok: true; items: BacklogItem[] } | { ok: false; error: string };

interface RawItem {
  title: string;
  detail?: string;
  category?: string;
  estimate?: string;
  priority?: number;
  dueAt?: string;
  blockedBy: string[];
  children: RawItem[];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function rawItem(input: unknown): RawItem | null {
  if (typeof input === 'string') return { title: input.trim(), blockedBy: [], children: [] };
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const blockedRaw = rec.blockedBy ?? rec.blocked_by ?? rec.dependsOn ?? rec.depends_on;
  const blockedBy = Array.isArray(blockedRaw) ? blockedRaw.map(String) : typeof blockedRaw === 'string' ? [blockedRaw] : [];
  const childrenRaw = rec.children ?? rec.subtasks ?? rec.tasks;
  const children = Array.isArray(childrenRaw) ? childrenRaw.map(rawItem).filter((c): c is RawItem => c !== null) : [];
  return {
    title: String(rec.title ?? '').trim(),
    detail: str(rec.detail) ?? str(rec.notes),
    category: str(rec.category) ?? str(rec.phase),
    estimate: str(rec.estimate),
    priority: typeof rec.priority === 'number' ? rec.priority : rec.priority == null ? undefined : Number(rec.priority),
    dueAt: str(rec.dueAt) ?? str(rec.due),
    blockedBy,
    children,
  };
}

function clampPriority(p: number | undefined): number {
  if (p === undefined || !Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(3, Math.trunc(p)));
}

function normalizeCategory(v: string | undefined): string | null {
  const c = v?.trim() ?? '';
  return c === '' ? null : c.slice(0, CATEGORY_MAX);
}

/**
 * Validate and flatten a raw item list (what the tool receives) into
 * write-ready items. Children inherit the parent's category unless they
 * name their own. Dependencies may point forward in the list.
 */
export function parseBacklog(raw: unknown): ParsedBacklog {
  const top = Array.isArray(raw) ? raw : [];
  const roots = top.map(rawItem).filter((r): r is RawItem => r !== null);
  if (roots.length === 0) return { ok: false, error: 'No items with a title were provided.' };

  // Flatten depth-first so a parent always precedes its children (the write
  // order) and `#n` numbering reads top to bottom like the plan it came from.
  const flat: { raw: RawItem; item: BacklogItem }[] = [];
  const walk = (node: RawItem, parentIndex: number | null, inherited: string | null, depth: number): string | null => {
    if (depth > 10) return 'Items nest deeper than 10 levels.';
    if (!node.title) return `Item ${flat.length + 1} has no title.`;
    if (flat.length >= MAX_ITEMS) return `More than ${MAX_ITEMS} items in one call.`;
    const category = normalizeCategory(node.category) ?? inherited;
    const item: BacklogItem = {
      index: flat.length + 1,
      title: node.title.replace(/\s+/g, ' ').slice(0, TITLE_MAX),
      notes: node.detail?.trim() ? node.detail.trim().slice(0, NOTES_MAX) : null,
      category,
      estimate: normalizeEstimate(node.estimate),
      priority: clampPriority(node.priority),
      dueAt: node.dueAt?.trim() || null,
      parentIndex,
      blockedByIndexes: [],
      blockedByIds: [],
    };
    flat.push({ raw: node, item });
    for (const child of node.children) {
      const err = walk(child, item.index, category, depth + 1);
      if (err) return err;
    }
    return null;
  };
  for (const root of roots) {
    const err = walk(root, null, null, 0);
    if (err) return { ok: false, error: err };
  }

  // Resolve references now that every title and position is known.
  const byTitle = new Map<string, number>();
  for (const { item } of flat) {
    const key = item.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, item.index);
  }
  for (const { raw: node, item } of flat) {
    for (const ref of node.blockedBy) {
      const r = ref.trim();
      if (!r) continue;
      const hash = /^#?(\d+)$/.exec(r);
      let index: number | undefined;
      if (hash) index = Number(hash[1]);
      else if (UUID_RE.test(r)) {
        if (!item.blockedByIds.includes(r)) item.blockedByIds.push(r);
        continue;
      } else index = byTitle.get(r.toLowerCase());
      if (index === undefined || index < 1 || index > flat.length) {
        return { ok: false, error: `Item ${item.index} ("${item.title}") is blocked by "${r}", which is not an item in this list, a #position, or a task id.` };
      }
      if (index === item.index) continue;
      if (!item.blockedByIndexes.includes(index)) item.blockedByIndexes.push(index);
    }
  }
  return { ok: true, items: flat.map((f) => f.item) };
}

export interface AddBacklogOptions {
  source?: string;
  sourceRef?: TaskSourceRef;
  /** Browser/user zone for bare `YYYY-MM-DD` due dates. */
  tz?: string | null;
}

export interface AddedBacklogItem {
  index: number;
  task: Task;
}

/**
 * Write a parsed backlog for the principal. Parents are created before
 * their children (the flattened order guarantees it), then dependencies are
 * written in a second pass once every id exists. Existing-task blockers go
 * through the scoped repo's ownership check like any other write.
 */
export async function addBacklog(principal: Principal, items: BacklogItem[], opts: AddBacklogOptions = {}): Promise<AddedBacklogItem[]> {
  const repo = scopedRepos(principal).tasks;
  const tz = await resolveUserTimezone(principal.userId, opts.tz ?? undefined);
  // Fail on a foreign or unknown existing-task blocker before writing anything.
  const existing = [...new Set(items.flatMap((i) => i.blockedByIds))];
  if (existing.length > 0) {
    const owned = await repo.ownedIds(existing);
    const missing = existing.find((id) => !owned.has(id));
    if (missing) throw new Error(`Blocking task not found: ${missing}`);
  }

  const idByIndex = new Map<number, string>();
  const added: AddedBacklogItem[] = [];
  for (const item of items) {
    const task = await repo.create({
      title: item.title,
      notes: item.notes,
      category: item.category,
      estimate: item.estimate,
      priority: item.priority,
      dueAt: item.dueAt ? parseDue(item.dueAt, tz) : null,
      parentId: item.parentIndex ? (idByIndex.get(item.parentIndex) ?? null) : null,
      source: opts.source ?? 'agent',
      sourceRef: opts.sourceRef,
    });
    idByIndex.set(item.index, task.id);
    added.push({ index: item.index, task });
  }

  for (const entry of added) {
    const item = items[entry.index - 1];
    const blockedBy = [...item.blockedByIndexes.map((i) => idByIndex.get(i)!).filter(Boolean), ...item.blockedByIds];
    if (blockedBy.length === 0) continue;
    const updated = await repo.update(entry.task.id, { blockedBy });
    if (updated) entry.task = updated;
  }
  return added;
}

function parseDue(value: string, tz: string): Date | null {
  const dateOnly = dateOnlyToEndOfDay(value, tz);
  if (dateOnly) return dateOnly;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
