'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The roles that run on one lane, shown under that lane's card.
 *
 * Roles used to be sixteen folders in the source tree and nothing else: you
 * could edit a role's tool list from the Tools page, but never add one, and
 * nowhere said which model a role would run on. They live here because the
 * arrow runs role → lane — a role's `defaultTopic` resolves to the lane, and
 * nothing goes the other way — so a lane's card is the one place where "who
 * runs on this model" is a complete answer.
 *
 * How a role gets USED, since the grouping does not say it: a role is chosen by
 * the model naming it in `spawn_child`, off the one-line description below.
 * That is why description is a first-class field and not a comment — a role
 * with a blank one is a bare name in the delegation menu and never gets picked.
 */

export interface RoleRow {
  role: string;
  description: string;
  defaultTopic: string;
  lane: string;
  toolIds: string[];
  readOnly: boolean;
  isSystem: boolean;
  /** Admin-only in the API response — the editor below is admin-only too. */
  systemPromptTemplate?: string;
  criticalRules?: string[];
}

export interface ToolOption {
  id: string;
  name: string;
}

interface Draft {
  role: string;
  description: string;
  defaultTopic: string;
  systemPromptTemplate: string;
  toolIds: string[];
  readOnly: boolean;
}

const emptyDraft = (lane: string): Draft => ({
  role: '',
  description: '',
  defaultTopic: lane,
  systemPromptTemplate: '',
  toolIds: [],
  readOnly: false,
});

const toDraft = (r: RoleRow): Draft => ({
  role: r.role,
  description: r.description,
  defaultTopic: r.defaultTopic,
  systemPromptTemplate: r.systemPromptTemplate ?? '',
  toolIds: r.toolIds,
  readOnly: r.readOnly,
});

const inputCls =
  'w-full bg-surface-container-low border border-outline-variant/10 rounded text-xs px-2 py-1.5 text-on-surface';

function RoleEditor({
  draft: initial,
  lanes,
  tools,
  existing,
  onClose,
}: {
  draft: Draft;
  lanes: { value: string; label: string }[];
  tools: ToolOption[];
  /** The row being edited; absent for a new role. */
  existing?: RoleRow;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isNew = !existing;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const toggleTool = (id: string) =>
    set('toolIds', draft.toolIds.includes(id) ? draft.toolIds.filter((t) => t !== id) : [...draft.toolIds, id]);

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['roles-config'] });
    onClose();
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (isNew) {
        await api.post('/roles', draft);
      } else {
        // Only what changed: PATCH treats an absent field as unchanged, and a
        // system role's defaultTopic is resynced from its folder at every boot,
        // so sending it back would be a write that silently reverts.
        await api.patch(`/roles/${existing.role}`, {
          description: draft.description,
          systemPromptTemplate: draft.systemPromptTemplate,
          toolIds: draft.toolIds,
          readOnly: draft.readOnly,
          ...(existing.isSystem ? {} : { defaultTopic: draft.defaultTopic }),
        });
      }
      await done();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing || existing.isSystem) return;
    setBusy(true);
    setError('');
    try {
      await api.delete(`/roles/${existing.role}`);
      await done();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
      setBusy(false);
    }
  };

  const valid = draft.role.trim() && draft.systemPromptTemplate.trim() && draft.toolIds.length > 0;

  return (
    <div className="mt-2 rounded border border-outline-variant/20 bg-surface-container-low p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-on-surface">
          {isNew ? 'New role' : `Editing ${existing.role}`}
        </span>
        <button onClick={onClose} className="text-on-surface-variant cursor-pointer" aria-label="Close editor">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">Name</span>
          <input
            className={cn(inputCls, 'font-mono disabled:opacity-60')}
            value={draft.role}
            disabled={!isNew}
            placeholder="translator"
            onChange={(e) => set('role', e.target.value.toLowerCase())}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">Lane</span>
          <select
            className={cn(inputCls, 'disabled:opacity-60')}
            value={draft.defaultTopic}
            disabled={!isNew && existing.isSystem}
            onChange={(e) => set('defaultTopic', e.target.value)}
          >
            {lanes.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
            {!lanes.some((l) => l.value === draft.defaultTopic) && (
              <option value={draft.defaultTopic}>{draft.defaultTopic}</option>
            )}
          </select>
        </label>
      </div>

      <label className="space-y-1 block">
        <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">
          Description — the line an agent reads when picking who to delegate to
        </span>
        <input
          className={inputCls}
          value={draft.description}
          placeholder="translate documents between languages"
          onChange={(e) => set('description', e.target.value)}
        />
      </label>

      <label className="space-y-1 block">
        <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">System prompt</span>
        <textarea
          className={cn(inputCls, 'font-mono h-32 resize-y')}
          value={draft.systemPromptTemplate}
          placeholder="You are…"
          onChange={(e) => set('systemPromptTemplate', e.target.value)}
        />
      </label>

      <div className="space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">
          Tools ({draft.toolIds.length} selected)
        </span>
        <div className="flex flex-wrap gap-1.5">
          {tools.map((tool) => {
            const on = draft.toolIds.includes(tool.id);
            return (
              <button
                key={tool.id}
                onClick={() => toggleTool(tool.id)}
                title={tool.name}
                className={cn(
                  'px-2 py-0.5 text-[11px] font-mono rounded-full ring-1 cursor-pointer',
                  on
                    ? 'bg-primary-container/60 text-primary ring-primary/30'
                    : 'bg-surface-container text-on-surface-variant ring-outline-variant/20',
                )}
              >
                {tool.id}
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-on-surface-variant">
        <input type="checkbox" checked={draft.readOnly} onChange={(e) => set('readOnly', e.target.checked)} />
        Read-only — strip the file-writing tools from this role
      </label>

      {error && <p className="text-xs text-error bg-error/10 px-2 py-1 rounded">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={!valid || busy}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-primary-container/60 text-primary disabled:opacity-40 cursor-pointer"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          {isNew ? 'Create role' : 'Save role'}
        </button>
        {existing && !existing.isSystem && (
          <button
            onClick={remove}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded text-error cursor-pointer disabled:opacity-40"
          >
            <Trash2 className="w-3 h-3" />
            Delete
          </button>
        )}
        {!valid && <span className="text-[11px] text-on-surface-variant">Name, prompt and one tool are required.</span>}
      </div>
    </div>
  );
}

export function LaneRoles({
  lane,
  roles,
  lanes,
  tools,
  canEdit,
}: {
  lane: string;
  roles: RoleRow[];
  lanes: { value: string; label: string }[];
  tools: ToolOption[];
  canEdit: boolean;
}) {
  // `null` = closed, '' = the new-role form, otherwise the role being edited.
  const [open, setOpen] = useState<string | null>(null);
  const editing = open ? roles.find((r) => r.role === open) : undefined;

  return (
    <div className="mt-3 pt-3 border-t border-outline-variant/10">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-on-surface-variant mr-1">Roles</span>
        {roles.length === 0 && (
          <span className="text-xs text-on-surface-variant">None — work routed here runs as the root agent.</span>
        )}
        {roles.map((r) => (
          <button
            key={r.role}
            onClick={() => canEdit && setOpen(open === r.role ? null : r.role)}
            title={r.description || 'no description — agents will not pick this role'}
            disabled={!canEdit}
            className={cn(
              'px-2 py-0.5 text-[11px] font-mono rounded-full ring-1 ring-outline-variant/20',
              canEdit && 'cursor-pointer',
              open === r.role ? 'bg-primary-container/60 text-primary' : 'bg-surface-container-high text-on-surface-variant',
              !r.isSystem && 'ring-primary/30',
            )}
          >
            {r.role}
          </button>
        ))}
        {canEdit && (
          <button
            onClick={() => setOpen(open === '' ? null : '')}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full ring-1 ring-outline-variant/20 text-on-surface-variant cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            role
          </button>
        )}
      </div>

      {canEdit && open !== null && (
        <RoleEditor
          // Remount on target change so the form is seeded once per role.
          key={open || `new:${lane}`}
          draft={editing ? toDraft(editing) : emptyDraft(lane)}
          existing={editing}
          lanes={lanes}
          tools={tools}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
