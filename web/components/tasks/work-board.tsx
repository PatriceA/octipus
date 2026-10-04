'use client';

import { Bot, ChevronDown, ChevronRight, Lock, LockOpen, MessageSquare, RefreshCw, Send, UserRound, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { TASK_CHECKOUT_TTL_MS } from '../../../src/core/tasks/checkout';
import type { TaskAssigneeKind } from '../../../src/core/tasks/status';

/**
 * The work-board pieces of the tasks page (after Paperclip): who a task is
 * assigned to, who holds it checked out, its comment thread (the agents'
 * progress and hand-off log) and the per-role heartbeat agents. The page owns
 * the task list; these render one task's board fields or the roles panel.
 */

/** The board fields a task row or card carries (see src/db/schema/tasks.ts). */
export interface BoardFields {
  assigneeKind?: TaskAssigneeKind | null;
  assigneeRef?: string | null;
  checkedOutBy?: string | null;
  checkedOutAt?: string | null;
  checkoutRunId?: string | null;
  /** When the claim lapses: `checkedOutAt` + the TTL, computed by the server. */
  leaseExpiresAt?: string | null;
  /** Client-side: the server's clock minus ours when the list was read. */
  serverSkewMs?: number;
}

export type AssigneePatch = { assigneeKind: TaskAssigneeKind | null; assigneeRef?: string | null };

/** The toolbar's assignee filter: everything, nobody, any agent, or one role. */
export type AssigneeFilter = 'all' | 'unassigned' | 'agents' | `role:${string}`;

export function matchesAssigneeFilter(task: BoardFields, filter: AssigneeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unassigned') return !task.assigneeKind;
  // Roles and swarm nodes are worked by agents; a user assignee is a person.
  if (filter === 'agents') return task.assigneeKind === 'role' || task.assigneeKind === 'node';
  return task.assigneeKind === 'role' && task.assigneeRef === filter.slice('role:'.length);
}

const KIND_LABEL: Record<TaskAssigneeKind, string> = { user: 'person', role: 'role', node: 'agent (node)' };

function AssigneeIcon({ kind, className }: { kind: TaskAssigneeKind; className?: string }) {
  if (kind === 'role') return <Users className={className} aria-hidden />;
  if (kind === 'node') return <Bot className={className} aria-hidden />;
  return <UserRound className={className} aria-hidden />;
}

/** "who" on a row or card: an icon for person / role / agent node, then the ref. */
export function AssigneeChip({ task }: { task: BoardFields }) {
  if (!task.assigneeKind || !task.assigneeRef) return null;
  const title = task.assigneeKind === 'role'
    ? `Assigned to the ${task.assigneeRef} role: any ${task.assigneeRef} agent may pick it up`
    : task.assigneeKind === 'node'
      ? `Assigned to agent node ${task.assigneeRef}`
      : `Assigned to ${task.assigneeRef}`;
  return (
    <span
      data-testid="task-assignee"
      data-kind={task.assigneeKind}
      title={title}
      className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary inline-flex items-center gap-0.5 max-w-[12rem]"
    >
      <AssigneeIcon kind={task.assigneeKind} className="w-2.5 h-2.5 shrink-0" />
      <span className="truncate">{task.assigneeKind === 'role' ? `${task.assigneeRef} role` : task.assigneeRef}</span>
    </span>
  );
}

/**
 * Set, change or clear the assignee. Roles pick from the known list; a person
 * or node is free text, saved on blur or Enter. Clearing sends a null kind.
 */
export function AssigneeEditor({
  task,
  roles,
  onChange,
}: {
  task: BoardFields;
  roles: readonly string[];
  onChange: (patch: AssigneePatch) => void;
}) {
  const [kind, setKind] = useState<TaskAssigneeKind | ''>(task.assigneeKind ?? '');
  const [ref, setRef] = useState(task.assigneeRef ?? '');
  // Mid-edit: a kind picked or text typed that is not saved yet. Until then
  // an outside change (an agent reassigning, a refetch) must not wipe it;
  // otherwise the editor follows the task, adjusted during render like the
  // notes editor.
  const [dirty, setDirty] = useState(false);
  const incoming = `${task.assigneeKind ?? ''}:${task.assigneeRef ?? ''}`;
  const [seeded, setSeeded] = useState(incoming);
  if (!dirty && seeded !== incoming) {
    setSeeded(incoming);
    setKind(task.assigneeKind ?? '');
    setRef(task.assigneeRef ?? '');
  }
  // Picking person or node moves the cursor to the text it needs.
  const textRef = useRef<HTMLInputElement>(null);
  const focusText = useRef(false);
  useEffect(() => {
    if (!focusText.current) return;
    focusText.current = false;
    textRef.current?.focus();
  }, [kind]);
  const roleOptions = task.assigneeKind === 'role' && task.assigneeRef && !roles.includes(task.assigneeRef)
    ? [...roles, task.assigneeRef]
    : roles;

  const commit = (k: TaskAssigneeKind | '', r: string) => {
    const value = r.trim();
    if (k === '') {
      setDirty(false);
      if (task.assigneeKind) onChange({ assigneeKind: null });
      return;
    }
    if (!value) return; // still mid-edit: a person or node needs a name
    setDirty(false);
    if (k === task.assigneeKind && value === task.assigneeRef) return;
    onChange({ assigneeKind: k, assigneeRef: value });
  };

  return (
    <span className="inline-flex items-center gap-1" data-testid="assignee-editor">
      <select
        value={kind}
        aria-label="Assignee kind"
        onChange={(e) => {
          const k = e.target.value as TaskAssigneeKind | '';
          setKind(k);
          // A role needs a pick from the list; start from the first so one
          // change is enough. Person and node wait for their text.
          const next = k === 'role' ? (roleOptions.includes(ref) ? ref : (roleOptions[0] ?? '')) : k === task.assigneeKind ? ref : '';
          setRef(next);
          setDirty(true);
          if (k === '' || k === 'role') commit(k, next);
          else focusText.current = true;
        }}
        className="rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface"
      >
        <option value="">unassigned</option>
        {(Object.keys(KIND_LABEL) as TaskAssigneeKind[]).map((k) => (
          <option key={k} value={k}>{KIND_LABEL[k]}</option>
        ))}
      </select>
      {kind === 'role' ? (
        <select
          value={ref}
          aria-label="Assignee role"
          onChange={(e) => {
            setRef(e.target.value);
            commit('role', e.target.value);
          }}
          className="rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface"
        >
          {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      ) : kind !== '' ? (
        <input
          ref={textRef}
          type="text"
          value={ref}
          aria-label={kind === 'node' ? 'Agent node' : 'Person'}
          placeholder={kind === 'node' ? 'node id…' : 'who…'}
          onChange={(e) => {
            setRef(e.target.value);
            setDirty(true);
          }}
          onBlur={() => commit(kind, ref)}
          onKeyDown={(e) => e.key === 'Enter' && commit(kind, ref)}
          className="w-28 rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface"
        />
      ) : null}
    </span>
  );
}

/** "3m ago" for a past instant. */
export function ago(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * A checkout holder, readable: `user:<id>` is you, `<role>@<session>` is
 * that role's agent, `pipeline:<id>/<node>` a pipeline step. The raw value
 * stays in the badge's title.
 */
export function holderLabel(holder: string): string {
  if (holder.startsWith('user:')) return 'you';
  if (holder.startsWith('pipeline:')) return `pipeline ${holder.split('/').pop()}`;
  const at = holder.indexOf('@');
  if (at > 0) return `${holder.slice(0, at)} agent`;
  return holder;
}

/**
 * The lease on a checked-out task: live until `leaseExpiresAt`, lapsed after;
 * null when nobody holds it. "Now" is the server's (our clock plus the skew
 * measured when the list was read), so a browser clock that is off does not
 * turn a live claim into a lapsed one. An older server without
 * `leaseExpiresAt` falls back to `checkedOutAt` + the TTL.
 */
export function leaseOf(
  task: BoardFields,
  clientNow: number = Date.now(),
): { live: boolean; holder: string; since: string; now: number; remainingMs: number } | null {
  if (!task.checkedOutBy || !task.checkedOutAt) return null;
  const at = new Date(task.checkedOutAt).getTime();
  if (Number.isNaN(at)) return null;
  const expires = task.leaseExpiresAt ? new Date(task.leaseExpiresAt).getTime() : at + TASK_CHECKOUT_TTL_MS;
  const now = clientNow + (task.serverSkewMs ?? 0);
  const remainingMs = expires - now;
  return { live: remainingMs > 0, holder: task.checkedOutBy, since: task.checkedOutAt, now, remainingMs };
}

/** The lock badge: "<holder> · working · 4m ago", or "claim lapsed" once the lease ran out. */
export function LeaseBadge({ task }: { task: BoardFields }) {
  const lease = leaseOf(task);
  if (!lease) return null;
  return lease.live ? (
    <span
      data-testid="task-lease"
      data-live="true"
      title={`Checked out by ${lease.holder} at ${new Date(lease.since).toLocaleString()}; the claim lapses in ${Math.ceil(lease.remainingMs / 60_000)}m unless renewed`}
      className="text-[10px] inline-flex items-center gap-0.5 text-tertiary"
    >
      <Lock className="w-2.5 h-2.5" /> {holderLabel(lease.holder)} · working · {ago(lease.since, lease.now)}
    </span>
  ) : (
    <span
      data-testid="task-lease"
      data-live="false"
      title={`${lease.holder} checked this out ${ago(lease.since, lease.now)} and has not renewed; anyone may take it over`}
      className="text-[10px] inline-flex items-center gap-0.5 text-on-surface-variant/70"
    >
      <LockOpen className="w-2.5 h-2.5" /> claim lapsed
    </span>
  );
}

/** "Release claim": frees a checkout, an agent's included, after a confirm. */
export function ReleaseClaimButton({ task, onRelease, compact }: { task: BoardFields; onRelease: () => void; compact?: boolean }) {
  if (!task.checkedOutBy) return null;
  return (
    <button
      onClick={() => {
        if (confirm(`Release the claim held by ${holderLabel(task.checkedOutBy!)}? The task goes back to open, and an agent still working it is refused its next write.`)) onRelease();
      }}
      aria-label="Release claim"
      title="Release claim"
      className={compact ? 'text-on-surface-variant hover:text-primary' : 'text-[10px] inline-flex items-center gap-0.5 text-on-surface-variant/70 hover:text-on-surface'}
    >
      <LockOpen className={compact ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'} />
      {!compact && ' release claim'}
    </button>
  );
}

interface TaskComment {
  id: string;
  authorKind: 'user' | 'agent';
  authorRef: string;
  body: string;
  createdAt: string;
}

/**
 * A task's comment thread, fetched when it opens (mount = open). Agents log
 * progress and hand-offs here through the tasks tool; the user posts as
 * themselves. `truncated` means the server left the oldest out. Without
 * `canComment` (a viewer in a space, an archived space) it is read-only.
 */
export function CommentsThread({ taskId, indent = true, canComment = true }: { taskId: string; indent?: boolean; canComment?: boolean }) {
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ comments: TaskComment[]; truncated: boolean }>(`/tasks/${taskId}/comments`);
      setComments(data.comments ?? []);
      setTruncated(Boolean(data.truncated));
      setError('');
    } catch (err) {
      setError((err as Error).message);
      setComments((c) => c ?? []);
    }
  }, [taskId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lazy load when the thread opens; load sets state from the server
    load();
  }, [load]);

  const post = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const comment = await api.post<TaskComment>(`/tasks/${taskId}/comments`, { body });
      setComments((cs) => [...(cs ?? []), comment]);
      setDraft('');
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className={`mt-2 space-y-1.5 ${indent ? 'pl-8' : ''}`} data-testid="task-comments">
      {comments === null ? (
        <p className="text-[11px] text-on-surface-variant inline-flex items-center gap-1">
          <RefreshCw className="w-3 h-3 animate-spin" /> loading comments…
        </p>
      ) : (
        <>
          {truncated && <p className="text-[11px] text-on-surface-variant/70 italic">older comments are hidden</p>}
          {comments.length === 0 && <p className="text-[11px] text-on-surface-variant/70">no comments yet — agents log progress and hand-offs here</p>}
          {comments.map((c) => (
            <div key={c.id} data-testid="task-comment" data-author={c.authorKind} className="text-xs">
              <p className="text-[10px] text-on-surface-variant inline-flex items-center gap-1">
                {c.authorKind === 'agent'
                  ? <><Bot className="w-2.5 h-2.5" aria-hidden /> <span className="text-primary">{holderLabel(c.authorRef)}</span></>
                  : <><UserRound className="w-2.5 h-2.5" aria-hidden /> <span>you</span></>}
                <span title={new Date(c.createdAt).toLocaleString()}>· {ago(c.createdAt)}</span>
              </p>
              <p className="text-on-surface whitespace-pre-wrap break-words">{c.body}</p>
            </div>
          ))}
        </>
      )}
      {error && <p className="text-[11px] text-error">{error}</p>}
      {canComment && <div className="flex gap-2 items-start">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post();
          }}
          rows={2}
          aria-label="Comment"
          placeholder="Comment for the agents working this…"
          className="flex-1 rounded-xs border border-outline-variant/20 bg-surface px-2 py-1.5 text-xs text-on-surface resize-y"
        />
        <button
          onClick={post}
          disabled={posting || !draft.trim()}
          className="text-xs px-2 py-1 rounded bg-primary/10 text-primary inline-flex items-center gap-1 disabled:opacity-40"
        >
          <Send className="w-3 h-3" /> Post
        </button>
      </div>}
    </div>
  );
}

/** The toggle that opens a task's comment thread. */
export function CommentsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={`text-[10px] inline-flex items-center gap-0.5 ${open ? 'text-primary' : 'text-on-surface-variant/70'} hover:text-on-surface`}
      title={open ? 'Hide comments' : 'Show comments'}
    >
      <MessageSquare className="w-2.5 h-2.5" /> comments
    </button>
  );
}

interface RoleAgentsData {
  roles: RoleAgentRow[];
  boardWritesAllowed: boolean;
  /** Older servers leave it out; treat that as on. */
  heartbeatEnabled?: boolean;
}

interface RoleAgentRow {
  role: string;
  activeTasks: number;
  totalTasks: number;
  enabled: boolean;
  hookId: string | null;
  known: boolean;
}

/**
 * Role agents: one heartbeat agent per role that has tasks on the board. On,
 * it wakes on the heartbeat, checks out ready tasks assigned to its role and
 * works them. It can only write to the board once tasks/write is ALLOW, which
 * the notice says (and links to) when it is not. `refreshKey` re-reads it
 * when the task list changes, so a newly assigned role shows up.
 */
export function RoleAgentsPanel({ refreshKey }: { refreshKey: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RoleAgentsData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.get<RoleAgentsData>('/tasks/role-agents'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-read when the task set changes; load sets state from the server
    load();
  }, [load, refreshKey]);

  const toggle = async (row: RoleAgentRow) => {
    setBusy(row.role);
    try {
      await api.put('/tasks/role-agents', { role: row.role, enabled: !row.enabled });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Roles with work on the board, plus any whose agent is on (so it can be turned off).
  const rows = (data?.roles ?? []).filter((r) => r.activeTasks > 0 || r.enabled);
  if (!data || rows.length === 0) return error ? <p className="text-xs text-error">{error}</p> : null;
  const running = rows.filter((r) => r.enabled).length;
  const heartbeatOff = data.heartbeatEnabled === false;

  return (
    <section className="rounded-xs border border-outline-variant/10 bg-surface-container-low/40" data-testid="role-agents">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-3 py-2 flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Bot className="w-3.5 h-3.5" />
        <span className="section-label">Role agents</span>
        <span className="text-xs">{running} of {rows.length} on · across all workspaces</span>
        {heartbeatOff ? (
          <span className="text-xs text-error ml-auto">heartbeat off on this server</span>
        ) : !data.boardWritesAllowed ? (
          <span className="text-xs text-error ml-auto">needs board permission</span>
        ) : null}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-xs text-on-surface-variant">
            A role agent wakes on the heartbeat, checks out ready tasks assigned to its role, works them and logs progress in the comments.
            Role agents are yours across all workspaces: each works every task assigned to its role, whichever workspace it is in.
          </p>
          {heartbeatOff && (
            <div role="note" data-testid="role-agents-heartbeat-off" className="bg-error/10 border border-error/20 rounded-xs px-3 py-2 text-xs text-on-surface">
              Heartbeat is disabled on this server; role agents won&apos;t run. An admin can turn it on with the{' '}
              <span className="font-mono">heartbeat.enabled</span> setting on the{' '}
              <a href="/settings" className="underline text-primary">settings page</a> (or the <span className="font-mono">HEARTBEAT_ENABLED</span> environment variable).
            </div>
          )}
          {!data.boardWritesAllowed && (
            <div role="note" data-testid="role-agents-permission" className="bg-error/10 border border-error/20 rounded-xs px-3 py-2 text-xs text-on-surface">
              Role agents can&apos;t work the board yet: the <span className="font-mono">tasks</span> tool&apos;s <span className="font-mono">write</span> action must be
              set to <strong>Allow</strong> (it asks by default, and nobody is there to answer a heartbeat). Set it on the{' '}
              <a href="/tools" className="underline text-primary">tools page</a>, or grant it on{' '}
              <a href="/permissions" className="underline text-primary">permissions</a>.
            </div>
          )}
          {error && <p className="text-xs text-error">{error}</p>}
          <ul className="space-y-1">
            {rows.map((r) => (
              <li key={r.role} className="flex items-center gap-3 text-sm" data-testid="role-agent">
                <Users className="w-3.5 h-3.5 text-on-surface-variant" aria-hidden />
                <span className="font-mono text-on-surface">{r.role}</span>
                <span className="text-xs text-on-surface-variant">
                  {r.activeTasks} open task{r.activeTasks === 1 ? '' : 's'}
                  {!r.known && ' · unknown role'}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  role="switch"
                  aria-checked={r.enabled}
                  aria-label={`${r.role} agent`}
                  disabled={busy === r.role || (!r.known && !r.enabled)}
                  onClick={() => toggle(r)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-40 ${r.enabled ? 'bg-primary' : 'bg-[#484847]'}`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-on-surface transition-transform ${r.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
