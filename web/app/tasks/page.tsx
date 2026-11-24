'use client';

import { CalendarDays, CircleCheck, Columns3, Home, Lightbulb, List, Menu, Pencil, RefreshCw, RotateCcw, Search, Star, Sun, Trash2, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blockedText, subtaskProgress, TaskBoard } from '@/components/tasks/task-board';
import { RemoteTasks } from '@/components/tasks/remote-tasks';
import { type AssigneeFilter, matchesAssigneeFilter, RoleAgentsPanel } from '@/components/tasks/work-board';
import { CaptureBar } from '@/components/todos/capture-bar';
import { ListsRail } from '@/components/todos/lists-rail';
import { localToday, type Todo } from '@/components/todos/model';
import { MyDaySuggestions } from '@/components/todos/my-day-suggestions';
import { TodoDetail } from '@/components/todos/todo-detail';
import { type RowContext, TodoRow } from '@/components/todos/todo-row';
import { type NewTodo, useTodos } from '@/components/todos/use-todos';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspace, useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';
import {
  isListKey, type ListKey, listCounts, listMembers, listTitle, orderBetween, PLANNED_GROUP_TITLE, type PlannedGroup,
  plannedGroup, renumbered, SMART_LISTS, type SmartList, splitList,
} from '../../../src/core/tasks/smart-lists';
import { isActiveStatus } from '../../../src/core/tasks/status';
import { toLookup } from '../../../src/core/tasks/structure';
import { pageShortcutAllowed } from '@/lib/shortcut-guard';

type View = 'list' | 'board';
const VIEW_KEY = 'octipus.tasks.view';
const LIST_KEY = 'octipus.todos.list';
/** Completed row is shown for a beat before it moves to the done part. */
const COMPLETE_MS = 420;
const DRAG_TYPE = 'application/x-octipus-todo';

function readLocal<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* per-viewer convenience only */
  }
}

/** The page is "To-dos": personal lists after Microsoft To Do, the board for spaces and agents. */
export default function TasksPage() {
  // A space on another install: its tasks through the remote source (federation §8.3).
  const { activeWorkspace } = useWorkspace();
  if (activeWorkspace?.kind === 'remote') return <div className="h-full overflow-y-auto p-6"><RemoteTasks key={activeWorkspace.id} remote={activeWorkspace} /></div>;
  return <TodosPage key={activeWorkspace?.id ?? 'personal'} />;
}

function TodosPage() {
  const router = useRouter();
  const params = useSearchParams();
  const workspaceId = useWorkspaceId();
  const { activeWorkspace } = useWorkspace();
  const isSpace = activeWorkspace?.kind === 'shared';
  // Commenters and viewers in a space (and everyone in an archived one) read
  // without create, edit or drag; commenters still comment.
  const { canWrite, canComment } = useWorkspaceAccess();
  // My Day, the star and the order are each member's own, so a space has them too.
  const smartLists: readonly SmartList[] = SMART_LISTS;

  const requested = params.get('list');
  const current: ListKey = isListKey(requested)
    ? requested
    : readLocal<ListKey>(`${LIST_KEY}.${workspaceId ?? 'personal'}`, isSpace ? 'all' : 'my-day', (raw) => (isListKey(raw) ? raw : isSpace ? 'all' : 'my-day'));
  const selectedId = params.get('task');
  const [view, setView] = useState<View>(() => readLocal(VIEW_KEY, 'list', (raw) => (raw === 'board' ? 'board' : 'list')));
  const todos = useTodos({ withArchived: current === 'archived' });
  const { tasks, archived } = todos;
  const [query, setQuery] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [completing, setCompleting] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'before' | 'after' } | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>('all');
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const captureRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const today = localToday();

  const href = useCallback((list: ListKey, task?: string | null) => {
    const q = new URLSearchParams({ list });
    if (task) q.set('task', task);
    return `/tasks?${q.toString()}`;
  }, []);
  const selectList = (key: ListKey) => {
    writeLocal(`${LIST_KEY}.${workspaceId ?? 'personal'}`, key);
    setRailOpen(false);
    setQuery('');
    setShowCompleted(false);
    router.push(href(key, null));
  };
  const open = useCallback((task: Todo | null) => router.replace(href(current, task?.id ?? null)), [current, href, router]);
  const chooseView = (v: View) => {
    setView(v);
    writeLocal(VIEW_KEY, v);
  };

  useEffect(() => {
    let cancelled = false;
    api.get<{ roles: { role: string }[] }>('/roles')
      .then((data) => { if (!cancelled) setRoleNames((data.roles ?? []).map((r) => r.role)); })
      .catch(() => { /* the pickers fall back to the roles already on to-dos */ });
    return () => { cancelled = true; };
  }, []);

  const lists = useMemo(() => {
    const named = new Set(tasks.filter((t) => t.category && t.status !== 'archived').map((t) => t.category as string));
    for (const l of todos.savedLists) named.add(l);
    if (current.startsWith('list:')) named.add(current.slice(5));
    return [...named].sort((a, b) => a.localeCompare(b));
  }, [tasks, todos.savedLists, current]);
  const counts = useMemo(() => listCounts(tasks, today), [tasks, today]);
  const lookup = useMemo(() => toLookup(tasks), [tasks]);
  const pickableRoles = useMemo(() => {
    const assigned = tasks.filter((t) => t.assigneeKind === 'role' && t.assigneeRef).map((t) => t.assigneeRef as string);
    return [...new Set([...roleNames, ...assigned])].sort((a, b) => a.localeCompare(b));
  }, [tasks, roleNames]);
  const createList = (name: string) => {
    void todos.createList(name);
    selectList(`list:${name}`);
  };

  const all = current === 'archived' ? archived : tasks;
  const searching = query.trim().length > 0;
  const members = useMemo(() => {
    if (searching) {
      const q = query.trim().toLowerCase();
      return [...tasks, ...archived].filter((t) => t.status !== 'archived' && `${t.title}\n${t.notes ?? ''}\n${t.category ?? ''}`.toLowerCase().includes(q));
    }
    return listMembers(all, current, today);
  }, [all, archived, current, query, searching, tasks, today]);
  const { active, done } = useMemo(() => splitList(members), [members]);
  const selected = selectedId ? [...tasks, ...archived].find((t) => t.id === selectedId) ?? null : null;

  // Rows in the order shown (for keyboard moves and drag), with Planned grouped by day.
  const sections = useMemo((): { key: string; title: string | null; rows: Todo[] }[] => {
    if (current === 'completed' || current === 'archived') return [{ key: 'rows', title: null, rows: current === 'archived' ? members : done }];
    if (current === 'planned' && !searching) {
      const groups = new Map<PlannedGroup, Todo[]>();
      for (const t of [...active].sort((a, b) => Date.parse(a.dueAt as string) - Date.parse(b.dueAt as string))) {
        const g = plannedGroup(t.dueAt as string, new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
        groups.set(g, [...(groups.get(g) ?? []), t]);
      }
      return (Object.keys(PLANNED_GROUP_TITLE) as PlannedGroup[]).filter((g) => groups.has(g)).map((g) => ({ key: g, title: PLANNED_GROUP_TITLE[g], rows: groups.get(g)! }));
    }
    return [{ key: 'rows', title: null, rows: active }];
  }, [active, current, done, members, searching]);
  const doneShown = current !== 'completed' && current !== 'archived' && done.length > 0;
  const visible = [...sections.flatMap((s) => s.rows), ...(doneShown && (showCompleted || searching) ? done : [])];
  const manualOrder = canWrite && !searching && current !== 'planned' && current !== 'completed' && current !== 'archived';

  // ── Actions ──────────────────────────────────────────────────────────
  const listDefaults = (): Partial<NewTodo> => {
    if (current === 'my-day') return { myDay: true };
    if (current === 'important') return { important: true };
    if (current === 'planned') return { dueAt: today };
    if (current.startsWith('list:')) return { category: current.slice(5) };
    return {};
  };
  const add = (todo: NewTodo) => {
    const defaults = listDefaults();
    // A new to-do goes to the top of the list it was typed in.
    const top = active[0]?.sortOrder;
    return todos.create({ ...defaults, ...todo, ...(todo.category === undefined && defaults.category ? { category: defaults.category } : {}), ...(top !== undefined ? { sortOrder: top - 1 } : {}) });
  };
  const toggle = (task: Todo) => {
    if (task.status === 'done' || completing.has(task.id)) {
      if (task.status === 'done') void todos.toggle(task);
      return;
    }
    // A beat of the ticked checkbox, then it moves to Completed.
    setCompleting((s) => new Set(s).add(task.id));
    setTimeout(() => {
      setCompleting((s) => {
        const n = new Set(s);
        n.delete(task.id);
        return n;
      });
      void todos.toggle(task);
    }, COMPLETE_MS);
  };
  const reorder = async (draggedId: string, targetId: string, edge: 'before' | 'after') => {
    const rows = sections.flatMap((s) => s.rows).filter((t) => isActiveStatus(t.status));
    const dragged = rows.find((t) => t.id === draggedId) ?? tasks.find((t) => t.id === draggedId);
    if (!dragged || draggedId === targetId) return;
    const rest = rows.filter((t) => t.id !== draggedId);
    const at = rest.findIndex((t) => t.id === targetId);
    if (at < 0) return;
    const index = edge === 'before' ? at : at + 1;
    const value = orderBetween(rest[index - 1]?.sortOrder, rest[index]?.sortOrder);
    if (value !== null) {
      await todos.update(dragged, { sortOrder: value });
      return;
    }
    // No room between the neighbours: number the whole list afresh.
    const ordered = [...rest.slice(0, index), dragged, ...rest.slice(index)];
    const orders = renumbered(ordered.length, ordered[0]?.sortOrder ?? 0);
    for (const [i, t] of ordered.entries()) {
      if (t.sortOrder !== orders[i]) await todos.update(t, { sortOrder: orders[i] }, { refetch: i === ordered.length - 1 });
    }
  };
  const dropOnList = (key: ListKey, id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (key.startsWith('list:')) {
      const name = key.slice(5);
      if ((task.category ?? '') === name) return;
      const before = task.category ?? null;
      void todos.update(task, { category: name });
      todos.showUndo(`Moved “${task.title}” to ${name}`, () => { void todos.update({ ...task, category: name }, { category: before }); });
    } else if (key === 'my-day') void todos.update(task, { myDay: true });
    else if (key === 'important') void todos.update(task, { important: true });
    else if (key === 'completed' && isActiveStatus(task.status)) toggle(task);
  };

  // ── Keyboard ─────────────────────────────────────────────────────────
  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  };
  const rowKeys = (task: Todo) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const i = visible.findIndex((t) => t.id === task.id);
    // Alt+Up / Alt+Down move the to-do itself (the keyboard's drag).
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const neighbour = visible[e.key === 'ArrowUp' ? i - 1 : i + 1];
      if (manualOrder && isActiveStatus(task.status) && neighbour && isActiveStatus(neighbour.status)) {
        void reorder(task.id, neighbour.id, e.key === 'ArrowUp' ? 'before' : 'after');
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(visible[i + 1]?.id); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(visible[i - 1]?.id); }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(visible[0]?.id); }
    else if (e.key === 'End') { e.preventDefault(); focusRow(visible.at(-1)?.id); }
    else if (e.key === ' ' && canWrite) { e.preventDefault(); toggle(task); }
    else if (e.key === 'Enter') { e.preventDefault(); open(task); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && canWrite && task.status !== 'archived') {
      e.preventDefault();
      focusRow((visible[i + 1] ?? visible[i - 1])?.id);
      todos.remove(task);
      if (selectedId === task.id) open(null);
    }
  };
  // Read through refs: the listener is registered once, and a key pressed
  // right after a row opened must already see it open.
  const keyState = useRef({ selectedId, open });
  useEffect(() => { keyState.current = { selectedId, open }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (e.key === 'Escape' && keyState.current.selectedId && !document.querySelector('dialog[open]')) {
        // Typing: Escape leaves the field first (a detail field), or is the field's own (capture, search).
        if (typing) {
          if (target?.closest('[data-testid="todo-detail"]')) target.blur();
          return;
        }
        keyState.current.open(null);
        return;
      }
      if (!pageShortcutAllowed(e)) return;
      if (e.key === 'n' && captureRef.current) { e.preventDefault(); captureRef.current.focus(); }
      else if (e.key === '/' && searchRef.current) { e.preventDefault(); searchRef.current.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────
  if (todos.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="h-6 w-6 animate-spin text-on-surface-variant" aria-label="Loading to-dos" />
      </div>
    );
  }

  const rowCtx: RowContext = { showList: !current.startsWith('list:'), showMyDay: current !== 'my-day', showAssignee: isSpace, today };
  const tabbable = focusedId && visible.some((t) => t.id === focusedId) ? focusedId : visible[0]?.id;
  const renderRow = (task: Todo) => {
    const draggable = manualOrder && isActiveStatus(task.status);
    return (
      <TodoRow
        key={task.id}
        ref={(el) => { if (el) rowRefs.current.set(task.id, el); else rowRefs.current.delete(task.id); }}
        task={task}
        ctx={rowCtx}
        steps={subtaskProgress(task, tasks)}
        waiting={blockedText(task, lookup)}
        selected={selectedId === task.id}
        completing={completing.has(task.id)}
        canWrite={canWrite && task.status !== 'archived'}
        canStar={task.status !== 'archived'}
        draggable={draggable}
        dropEdge={dropAt?.id === task.id ? dropAt.edge : null}
        tabIndex={tabbable === task.id ? 0 : -1}
        onFocus={() => setFocusedId(task.id)}
        onKeyDown={rowKeys(task)}
        onToggle={() => toggle(task)}
        onToggleImportant={() => void todos.update(task, { important: !task.important })}
        onOpen={() => open(selectedId === task.id ? null : task)}
        dragProps={canWrite && task.status !== 'archived' ? {
          onDragStart: (e) => {
            e.dataTransfer.setData(DRAG_TYPE, task.id);
            e.dataTransfer.setData('text/plain', task.title);
            e.dataTransfer.effectAllowed = 'move';
            setDragging(task.id);
          },
          onDragEnd: () => { setDragging(null); setDropAt(null); },
          onDragOver: (e) => {
            if (!dragging || !draggable || dragging === task.id) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const edge = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
            if (dropAt?.id !== task.id || dropAt.edge !== edge) setDropAt({ id: task.id, edge });
          },
          onDrop: (e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData(DRAG_TYPE) || dragging;
            const edge = dropAt?.edge ?? 'after';
            setDragging(null);
            setDropAt(null);
            if (id) void reorder(id, task.id, edge);
          },
        } : undefined}
      />
    );
  };

  const title = searching ? 'Search' : listTitle(current);
  const HeadingIcon = searching ? Search : current === 'my-day' ? Sun : current === 'important' ? Star : current === 'planned' ? CalendarDays : current === 'completed' ? CircleCheck : current === 'archived' ? RotateCcw : current === 'all' ? Home : List;
  const subtitle = current === 'my-day' && !searching
    ? new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : current === 'archived' && !searching ? 'Deleted to-dos. Open one to restore it.' : null;
  const canCapture = canWrite && !searching && current !== 'completed' && current !== 'archived';
  const suggestionsShown = current === 'my-day' && !searching && (showSuggestions || active.length === 0) && canWrite;

  return (
    <div className="todo-page">
      <ListsRail
        smart={smartLists}
        counts={counts}
        lists={lists}
        current={current}
        onSelect={selectList}
        onDrop={dropOnList}
        onCreateList={createList}
        canWrite={canWrite}
        open={railOpen}
        onClose={() => setRailOpen(false)}
      />
      <div className="todo-main">
        <div className="todo-main-scroll">
          <div className={cn('todo-main-inner', view === 'board' && '!max-w-[1280px]')}>
            {/* A div, not <header>: the app shell pads every header on phones for its own menu button. */}
            <div className="todo-heading">
              <div className="min-w-0 flex-1">
                <h1 className="flex items-center gap-2.5">
                  {view === 'board' ? <Columns3 className="h-6 w-6 shrink-0 text-primary" aria-hidden /> : <HeadingIcon className="h-6 w-6 shrink-0 text-primary" aria-hidden />}
                  {view === 'board' ? 'Board' : title}
                </h1>
                {subtitle && view === 'list' && <p>{subtitle}</p>}
              </div>
              {view === 'list' && current.startsWith('list:') && canWrite && !searching && (
                <ListActions name={current.slice(5)} lists={lists}
                  onRename={(to) => { todos.renameList(current.slice(5), to); router.replace(href(`list:${to}`, selectedId)); }}
                  onDelete={() => { todos.deleteList(current.slice(5)); selectList('all'); }} />
              )}
            </div>
            <div className="todo-toolbar">
              <button type="button" className="todo-tool todo-rail-toggle" aria-label="Show lists" onClick={() => setRailOpen(true)}><Menu className="h-5 w-5" /></button>
              {view === 'list' && (
                <label className="todo-search">
                  <Search className="h-4 w-4 shrink-0 text-on-surface-variant" aria-hidden />
                  <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search to-dos" placeholder="Search" />
                  {searching && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X className="h-4 w-4 text-on-surface-variant" /></button>}
                </label>
              )}
              <span className="todo-spacer" />
              {view === 'list' && current === 'my-day' && canWrite && (
                <button type="button" className="todo-tool" aria-pressed={showSuggestions} aria-label="Suggestions" title="Suggestions for today" onClick={() => setShowSuggestions((v) => !v)} data-testid="my-day-suggestions-toggle">
                  <Lightbulb className="h-4 w-4" /><span className="todo-tool-label">Suggestions</span>
                </button>
              )}
              <div role="group" aria-label="View" className="inline-flex gap-0.5">
                <button type="button" className="todo-tool" aria-pressed={view === 'list'} aria-label="List view" title="List" data-testid="tasks-view-list" onClick={() => chooseView('list')}><List className="h-4 w-4" /><span className="todo-tool-label">List</span></button>
                <button type="button" className="todo-tool" aria-pressed={view === 'board'} aria-label="Board view" title="Board" data-testid="tasks-view-board" onClick={() => chooseView('board')}><Columns3 className="h-4 w-4" /><span className="todo-tool-label">Board</span></button>
              </div>
            </div>

            {todos.error && (
              <div role="alert" className="mb-4 flex items-center gap-3 rounded-lg border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container">
                <span className="flex-1">{todos.error}</span>
                <button type="button" onClick={() => todos.setError('')} className="font-medium underline">Dismiss</button>
              </div>
            )}

            {view === 'board' ? (
              <BoardView todos={todos} lookup={lookup} filter={assigneeFilter} setFilter={setAssigneeFilter} canWrite={canWrite} canComment={canComment}
                onOpen={open} captureLists={lists} onAdd={(t) => todos.create(t)} />
            ) : (
              <>
                {canCapture && <CaptureBar ref={captureRef} lists={lists} onAdd={add} placeholder={current === 'my-day' ? 'Add a to-do for today' : 'Add a to-do'} />}
                {visible.length === 0 && !doneShown ? (
                  <EmptyList list={current} searching={searching} />
                ) : (
                  <div role="list" aria-label={title} className="todo-list" data-testid="todo-list">
                    {sections.map((s) => (
                      <div key={s.key} className="contents">
                        {s.title && <h2 className="todo-group-title">{s.title}</h2>}
                        {s.rows.map(renderRow)}
                      </div>
                    ))}
                  </div>
                )}
                {doneShown && (
                  <>
                    <button type="button" className="todo-section" aria-expanded={showCompleted || searching} onClick={() => setShowCompleted((v) => !v)} data-testid="todo-completed-toggle">
                      <span aria-hidden className={cn('inline-block transition-transform', (showCompleted || searching) && 'rotate-90')}>›</span>
                      Completed <span>{current === 'all' && !searching && todos.doneTotal !== null ? todos.doneTotal : done.length}</span>
                    </button>
                    {(showCompleted || searching) && <div role="list" aria-label="Completed" className="todo-list">{done.map(renderRow)}</div>}
                  </>
                )}
                {(current === 'completed' || (current === 'all' && showCompleted)) && !searching && todos.doneTotal !== null && todos.doneTotal > todos.doneLimit && (
                  <button type="button" onClick={todos.showMoreDone} className="todo-tool mt-3">
                    Show more done ({todos.doneTotal - todos.doneLimit} more)
                  </button>
                )}
                {suggestionsShown && (
                  <MyDaySuggestions version={`${counts.smart['my-day']}:${tasks.length}`} canWrite={canWrite} onAdd={(t) => void todos.update(t, { myDay: true })} />
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {selected && (
        <TodoDetail
          key={selected.id}
          task={selected}
          tasks={tasks}
          todos={todos}
          lists={lists}
          roles={pickableRoles}
          canWrite={canWrite}
          canComment={canComment}
          isSpace={isSpace}
          onClose={() => { open(null); focusRow(selected.id); }}
        />
      )}
      {todos.undoToast}
    </div>
  );
}

/** Rename or delete the list on screen (its to-dos stay; Undo is offered). */
function ListActions({ name, lists, onRename, onDelete }: { name: string; lists: readonly string[]; onRename: (to: string) => void; onDelete: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const commit = () => {
    const to = draft.trim();
    setRenaming(false);
    if (to && to !== name) onRename(to);
  };
  if (renaming) {
    return (
      <input autoFocus aria-label="List name" value={draft} maxLength={100} className="todo-field"
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(name); setRenaming(false); } }} />
    );
  }
  return (
    <div className="flex shrink-0 gap-1">
      <button type="button" className="todo-tool" onClick={() => { setDraft(name); setRenaming(true); }} aria-label="Rename list" title="Rename list">
        <Pencil className="h-4 w-4" /><span className="todo-tool-label">Rename</span>
      </button>
      <button type="button" className="todo-tool" onClick={onDelete} aria-label="Delete list" title="Delete list (its to-dos stay, in no list)">
        <Trash2 className="h-4 w-4" /><span className="todo-tool-label">Delete list</span>
      </button>
    </div>
  );
}

function EmptyList({ list, searching }: { list: ListKey; searching: boolean }) {
  const copy: Record<SmartList, [typeof Sun, string, string]> = {
    'my-day': [Sun, 'Focus on your day', 'Add to-dos for today, or pick from the suggestions below.'],
    important: [Star, 'Nothing important yet', 'Star a to-do to see it here.'],
    planned: [CalendarDays, 'Nothing planned', 'To-dos with a due date show up here, grouped by day.'],
    all: [Home, 'Nothing to do', 'Add a to-do above, or ask an agent to remind you.'],
    completed: [CircleCheck, 'Nothing completed yet', 'Ticked-off to-dos land here.'],
    archived: [RotateCcw, 'Nothing deleted', 'Deleted to-dos land here; open one to restore it.'],
  };
  const [Icon, heading, body] = searching
    ? [Search, 'No matches', 'Nothing in your to-dos matches that search.'] as const
    : list.startsWith('list:') ? [List, `Nothing in ${list.slice(5)} yet`, 'Add a to-do above, or drag one here from another list.'] as const
      : copy[list as SmartList];
  return (
    <div className="todo-empty" data-testid="todo-empty">
      <Icon aria-hidden />
      <h2>{heading}</h2>
      <p>{body}</p>
    </div>
  );
}

/**
 * The board (spaces, agents, plans): every to-do that is not archived in
 * status columns with list lanes, the role agents and the assignee filter.
 * Its cards open the same detail panel.
 */
function BoardView({ todos, lookup, filter, setFilter, canWrite, canComment, onOpen, captureLists, onAdd }: {
  todos: ReturnType<typeof useTodos>;
  lookup: ReadonlyMap<string, Todo>;
  filter: AssigneeFilter;
  setFilter: (f: AssigneeFilter) => void;
  canWrite: boolean;
  canComment: boolean;
  onOpen: (t: Todo) => void;
  captureLists: readonly string[];
  onAdd: (t: NewTodo) => Promise<unknown>;
}) {
  const { tasks } = todos;
  const assignedRoles = [...new Set(tasks.filter((t) => t.assigneeKind === 'role' && t.assigneeRef).map((t) => t.assigneeRef as string))].sort((a, b) => a.localeCompare(b));
  const assignmentKey = tasks.map((t) => `${t.id}:${t.assigneeKind ?? ''}:${t.assigneeRef ?? ''}:${t.status}`).join('|');
  const shown = tasks.filter((t) => t.status !== 'archived' && matchesAssigneeFilter(t, filter));
  return (
    <div className="space-y-4">
      <RoleAgentsPanel refreshKey={assignmentKey} />
      {canWrite && <CaptureBar lists={captureLists} onAdd={onAdd} />}
      <div className="flex flex-wrap items-center gap-2 text-sm text-on-surface-variant">
        <span>{canWrite ? 'Columns by status, lanes by list. Drag a card, or use its arrows.' : 'Columns by status, lanes by list.'}</span>
        <label className="ml-auto inline-flex items-center gap-2">
          Assignee
          <select value={filter} onChange={(e) => setFilter(e.target.value as AssigneeFilter)} data-testid="assignee-filter" className="todo-field">
            <option value="all">all</option>
            <option value="unassigned">unassigned</option>
            <option value="agents">assigned to agents</option>
            {assignedRoles.map((r) => <option key={r} value={`role:${r}`}>{r} role</option>)}
            {/* A chosen role whose last to-do went elsewhere stays visible (and clearable) rather than filtering silently. */}
            {filter.startsWith('role:') && !assignedRoles.includes(filter.slice(5)) && <option value={filter}>{filter.slice(5)} role (no tasks)</option>}
          </select>
        </label>
      </div>
      {filter !== 'all' && shown.length === 0 && <p className="text-sm text-on-surface-variant">No to-dos match this assignee filter.</p>}
      <TaskBoard
        tasks={shown}
        lookup={lookup}
        onSetStatus={(t, s) => void todos.setStatus(t, s)}
        onDelete={(id) => { const t = tasks.find((x) => x.id === id); if (t) todos.remove(t); }}
        onRelease={(t) => void todos.release(t)}
        onEdit={onOpen}
        canWrite={canWrite}
        canComment={canComment}
      />
    </div>
  );
}
