'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUndoToast } from '@/components/ui/undo-toast';
import { api } from '@/lib/api';
import { useGateway, useGatewayMessages, useGatewayStatus } from '@/lib/gateway-context';
import { useWorkspace, useWorkspaceId } from '@/lib/workspace-context';
import { isActiveStatus, type TaskStatus } from '../../../src/core/tasks/status';
import { browserTimezone, type Todo, type TodoPatch } from './model';

/** Done to-dos per page: the server's default for GET /tasks; "Show more" asks for another (`doneLimit`). */
export const DONE_PAGE = 50;
/** The most done to-dos one GET /tasks returns (`doneLimit` is capped there); more come with `doneOffset`. */
const DONE_REQUEST_MAX = 500;
/** How often the list re-reads while the live connection is down and the page is visible. */
const REFRESH_MS = 30_000;
/** A burst of `tasks.changed` / `task.changed` events re-reads the list once, this long after the last. */
const CHANGED_DEBOUNCE_MS = 400;

/**
 * The requests that read `loaded` done to-dos: the first (with the active
 * ones) as the plain default when it can be, then whole pages from
 * `doneOffset` onward, since the server caps one page.
 */
function donePages(loaded: number): string[] {
  const paths = [loaded === DONE_PAGE ? '/tasks' : `/tasks?doneLimit=${Math.min(loaded, DONE_REQUEST_MAX)}`];
  for (let offset = DONE_REQUEST_MAX; offset < loaded; offset += DONE_REQUEST_MAX) {
    paths.push(`/tasks?doneLimit=${Math.min(DONE_REQUEST_MAX, loaded - offset)}&doneOffset=${offset}`);
  }
  return paths;
}

export interface NewTodo {
  title: string;
  dueAt?: string | null;
  priority?: number;
  category?: string | null;
  important?: boolean;
  myDay?: boolean;
  repeat?: Todo['repeat'];
  parentId?: string;
  sortOrder?: number;
  assigneeKind?: string;
  assigneeRef?: string;
}

/**
 * The to-do list's data: one read of every active to-do plus pages of done
 * ones (and the archived ones when asked), every write optimistic and then
 * re-read, and live updates — a personal list refetches on `tasks.changed`
 * (every write of the owner's to-dos, an agent's included), a space's board on
 * `task.changed`; while the connection is down it polls every 30s instead.
 */
export function useTodos({ withArchived = false }: { withArchived?: boolean } = {}) {
  const workspaceId = useWorkspaceId();
  const { activeWorkspace } = useWorkspace();
  const spaceId = activeWorkspace?.kind === 'shared' ? activeWorkspace.id : null;
  const gateway = useGateway();
  const gatewayStatus = useGatewayStatus();
  const [tasks, setTasks] = useState<Todo[]>([]);
  const [archived, setArchived] = useState<Todo[]>([]);
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE);
  const [doneTotal, setDoneTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { show: showUndo, toast: undoToast } = useUndoToast();
  // To-dos deleted on screen whose Undo is still on offer (not sent yet).
  const pendingDeletes = useRef(new Set<string>());

  // A response from an earlier fetch is dropped so a slow reply cannot
  // overwrite a newer one. Local writes: how many are in flight, and a
  // version bumped as each starts and ends. A read that overlapped a write
  // (the poll, an event's refetch) may carry the server's state from before
  // it, so it is dropped rather than allowed to undo an optimistic edit; the
  // write's own re-read, started after it ended, is the one that lands. A
  // dropped read is never simply lost: if every write has settled it reads
  // again at once, else `dropped` makes the last write to settle read again.
  const fetchSeq = useRef(0);
  const writes = useRef({ pending: 0, version: 0, dropped: false });
  const fetchTasks = useCallback(() => {
    const load = async (): Promise<void> => {
      const seq = ++fetchSeq.current;
      const version = writes.current.version;
      try {
        const [pages, archivedPage] = await Promise.all([
          Promise.all(donePages(doneLimit).map((path) => api.get<{ tasks: Todo[]; serverNow?: string; done?: { total: number } }>(path))),
          withArchived ? api.get<{ tasks: Todo[] }>('/tasks?status=archived&limit=200') : Promise.resolve(null),
        ]);
        // Every page repeats the active to-dos: the first page's are kept, and
        // only the done ones of the later pages.
        const [first, ...later] = pages;
        const all = [...(first.tasks || []), ...later.flatMap((p) => (p.tasks || []).filter((t) => t.status === 'done'))];
        if (seq !== fetchSeq.current) return;
        const w = writes.current;
        if (w.pending > 0) {
          w.dropped = true;
          return;
        }
        if (w.version !== version) {
          void load();
          return;
        }
        // Leases are judged on the server's clock: remember how far ours is off.
        const serverMs = first.serverNow ? Date.parse(first.serverNow) : Number.NaN;
        const serverSkewMs = Number.isNaN(serverMs) ? 0 : serverMs - Date.now();
        // A deletion still on offer for Undo has not reached the server yet.
        setTasks(all.filter((t) => !pendingDeletes.current.has(t.id)).map((t) => ({ ...t, serverSkewMs })));
        if (archivedPage) setArchived(archivedPage.tasks ?? []);
        setDoneTotal(first.done?.total ?? null);
        setError('');
      } catch (err) {
        if (seq === fetchSeq.current) setError((err as Error).message);
      } finally {
        if (seq === fetchSeq.current) setLoading(false);
      }
    };
    return load();
    // A workspace switch re-creates the loader: the list is another workspace's.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- not read inside; its change re-creates the loader
  }, [workspaceId, doneLimit, withArchived]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  // Live: a space joins its resource on every (re)connect; personal events
  // reach the owner's connections without a subscription.
  useEffect(() => {
    if (spaceId && gatewayStatus === 'connected') gateway.send({ type: 'space.subscribe', spaceId });
  }, [gateway, spaceId, gatewayStatus]);
  const changedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (changedTimer.current) clearTimeout(changedTimer.current);
  }, []);
  useGatewayMessages((message) => {
    if (message.type !== 'event') return;
    const type = message.event.type;
    if (spaceId) {
      if (type !== 'task.changed' || (message.event.payload as { workspaceId?: string }).workspaceId !== spaceId) return;
    } else if (type !== 'tasks.changed') {
      return;
    }
    // Debounced: an agent's bulk edit sends one event per to-do.
    if (changedTimer.current) clearTimeout(changedTimer.current);
    changedTimer.current = setTimeout(() => {
      changedTimer.current = null;
      void fetchTasks();
    }, CHANGED_DEBOUNCE_MS);
  });
  // Keyed on `live`, not on the raw status: while the gateway is down it
  // cycles connecting/disconnected on every backoff retry, and a timer
  // re-armed on each flip would never reach 30s.
  const live = gatewayStatus === 'connected';
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void fetchTasks();
    };
    const timer = live ? null : setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [fetchTasks, live]);

  /**
   * Every write goes through here: the optimistic local change, the request,
   * then a fresh read (always after a failure, which also undoes the
   * optimistic change). See `writes` above for why the counter.
   */
  const write = useCallback(async <R,>(optimistic: (() => void) | null, request: () => Promise<R>, refetch = true): Promise<R | undefined> => {
    const w = writes.current;
    w.pending++;
    w.version++;
    optimistic?.();
    let failed = false;
    let result: R | undefined;
    try {
      result = await request();
    } catch (err) {
      failed = true;
      setError((err as Error).message);
    } finally {
      w.pending--;
      w.version++;
    }
    if (refetch || failed || (w.pending === 0 && w.dropped)) {
      w.dropped = false;
      await fetchTasks();
    }
    return failed ? undefined : result;
  }, [fetchTasks]);

  const local = useCallback((id: string, patch: Partial<Todo>) => {
    setTasks((xs) => xs.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setArchived((xs) => xs.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  /** Create a to-do; resolves to the new row (or undefined when it failed and the error shows). */
  const create = useCallback((input: NewTodo) => write(null, () => api.post<Todo>('/tasks', { ...input, tz: browserTimezone() })), [write]);

  /** Patch fields, optimistic. `myDay` is mirrored locally as today's date. */
  const update = useCallback((task: Todo, patch: TodoPatch, opts: { refetch?: boolean } = {}) => {
    // An assignee clear sends only the null kind; mirror the server locally.
    const sent = patch.assigneeKind === null ? { ...patch, assigneeRef: null } : patch;
    const { myDay, ...rest } = sent;
    const mirror: Partial<Todo> = { ...rest, ...(myDay !== undefined ? { myDayOn: myDay ? localDayNow() : null } : {}) };
    const needsZone = patch.dueAt !== undefined || patch.myDay !== undefined || patch.remindAt !== undefined;
    return write(
      () => local(task.id, mirror),
      () => api.patch<Todo>(`/tasks/${task.id}`, needsZone ? { ...sent, tz: browserTimezone() } : sent),
      opts.refetch ?? true,
    );
  }, [local, write]);

  /** Status moves (the checkbox, the board, the detail panel), optimistic. */
  const setStatus = useCallback((task: Todo, status: TaskStatus) => {
    if (task.status === status) return Promise.resolve(undefined);
    const completedAt = status === 'done' ? new Date().toISOString() : isActiveStatus(status) ? null : task.completedAt;
    return write(() => local(task.id, { status, completedAt }), () => api.patch<Todo>(`/tasks/${task.id}`, { status }));
  }, [local, write]);

  /**
   * Complete or reopen. Completing offers Undo (a second request that sets it
   * back to open, which also takes back an untouched repeat occurrence).
   */
  const toggle = useCallback((task: Todo) => {
    if (task.status === 'done') return setStatus(task, 'open');
    const before = task.status;
    const done = setStatus(task, 'done');
    showUndo(`Completed “${task.title}”`, () => { void setStatus({ ...task, status: 'done' }, before); });
    return done;
  }, [setStatus, showUndo]);

  /**
   * Deleting hides the to-do and offers Undo; only when the offer closes
   * without Undo is it archived (out of every list, restorable from
   * Archived). Archiving has effects Undo could not take back — it clears
   * the completion time, frees an agent's claim and wakes what waited on it —
   * so nothing is sent until then (see useUndoToast).
   */
  const remove = useCallback((task: Todo) => {
    const id = task.id;
    pendingDeletes.current.add(id);
    setTasks((xs) => xs.filter((t) => t.id !== id));
    showUndo(
      `Deleted “${task.title}”`,
      () => {
        pendingDeletes.current.delete(id);
        setTasks((xs) => (xs.some((t) => t.id === id) ? xs : [...xs, task]));
      },
      () => {
        void write(null, () => api.patch(`/tasks/${id}`, { status: 'archived' })).then((archivedRow) => {
          pendingDeletes.current.delete(id);
          // Not archived (the error shows): the to-do comes back.
          if (archivedRow === undefined) void fetchTasks();
        });
      },
    );
  }, [fetchTasks, showUndo, write]);

  /** Bring an archived (deleted) to-do back to the list. */
  const restore = useCallback((task: Todo) => write(
    () => {
      setArchived((xs) => xs.filter((t) => t.id !== task.id));
      setTasks((xs) => [...xs.filter((t) => t.id !== task.id), { ...task, status: 'open' }]);
    },
    () => api.patch<Todo>(`/tasks/${task.id}`, { status: 'open' }),
  ), [write]);

  // The user is the boss of the board: a forced release frees a claim an
  // agent holds (or left behind), and the task goes back to open.
  const release = useCallback((task: Todo) => write(null, () => api.post(`/tasks/${task.id}/release`, { force: true })), [write]);

  return {
    tasks,
    archived,
    loading,
    error,
    setError,
    doneTotal,
    doneLimit,
    showMoreDone: () => setDoneLimit((n) => n + DONE_PAGE),
    refetch: fetchTasks,
    create,
    update,
    setStatus,
    toggle,
    remove,
    restore,
    release,
    showUndo,
    undoToast,
    spaceId,
  };
}

function localDayNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type TodosApi = ReturnType<typeof useTodos>;
