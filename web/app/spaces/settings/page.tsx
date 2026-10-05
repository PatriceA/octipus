'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Check, Copy, Link2, LogOut, Trash2, UserMinus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { RoleBadge } from '@/components/workspace-picker';
import { PageHeader } from '@/components/ui/page-header';
import type { GuestScope } from '../../../../src/shared/spaces';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useRooms } from '@/lib/rooms';
import { type Space, type SpaceRole, useWorkspace } from '@/lib/workspace-context';

interface Member {
  userId: string;
  username: string;
  role: SpaceRole;
  joinedAt: string;
  /** A guest's scope; sent to owners only. */
  scope?: GuestScope;
}

interface Invite {
  id: string;
  role: Exclude<SpaceRole, 'owner'>;
  scope: GuestScope | null;
  createdByName: string | null;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revokedAt: string | null;
  createdAt: string;
}

interface CreatedInvite {
  id: string;
  token: string;
  role: Invite['role'];
  expiresAt: string;
  maxUses: number;
}

interface ActivityEntry {
  id: string;
  action: string;
  username: string | null;
  resourceType: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

const ROLES: SpaceRole[] = ['owner', 'editor', 'commenter', 'viewer', 'guest'];
const INVITABLE: Invite['role'][] = ['editor', 'commenter', 'viewer', 'guest'];
/** Invite lifetimes offered; the server clamps to `spaces.inviteMaxTtlHours`. */
const EXPIRY_HOURS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '1 day' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' },
];
const ACTIVITY_PAGE = 50;

const inputClass = 'px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface focus:outline-none focus:border-primary';
const buttonClass = 'inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-50 cursor-pointer';
const primaryClass = 'inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-xs bg-primary text-on-primary hover:bg-primary-dim disabled:opacity-50 cursor-pointer';

function activityLabel(action: string): string {
  return action.replace(/^space_/, '').replace(/_/g, ' ');
}

/**
 * `/spaces/:id/settings`: a space's name, members, invites, activity,
 * archive and purge. Every member reads it; the controls that change the
 * space (owner only, as the server enforces) are shown to owners only.
 */
export default function SpaceSettingsPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { refresh } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const spaceQ = useQuery({
    queryKey: ['space', id, 'detail'],
    queryFn: () => api.get<Space>(`/spaces/${id}`),
    retry: false,
  });
  const space = spaceQ.data;
  const isOwner = space?.role === 'owner';
  const archived = !!space?.archivedAt;

  const membersQ = useQuery({
    queryKey: ['space', id, 'members'],
    queryFn: () => api.get<{ members: Member[] }>(`/spaces/${id}/members`),
    enabled: !!space,
  });
  const invitesQ = useQuery({
    queryKey: ['space', id, 'invites'],
    queryFn: () => api.get<{ invites: Invite[] }>(`/spaces/${id}/invites`),
    enabled: isOwner,
  });
  const activityQ = useInfiniteQuery({
    queryKey: ['space', id, 'activity'],
    queryFn: ({ pageParam }) =>
      api.get<{ activity: ActivityEntry[] }>(
        `/spaces/${id}/activity?limit=${ACTIVITY_PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.activity.length === ACTIVITY_PAGE ? last.activity[last.activity.length - 1].createdAt : undefined,
    enabled: !!space,
  });

  /** Every change re-reads the space, its lists, its activity, and the picker's list. */
  const changed = async () => {
    setError(null);
    await qc.invalidateQueries({ queryKey: ['space', id] });
    await refresh();
  };
  const onError = (err: Error) => setError(err.message);

  const rename = useMutation({
    mutationFn: (name: string) => api.patch<Space>(`/spaces/${id}`, { name }),
    onSuccess: changed,
    onError,
  });
  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: SpaceRole; scope?: GuestScope }) =>
      api.patch(`/spaces/${id}/members/${v.userId}`, v.scope ? { role: v.role, scope: v.scope } : { role: v.role }),
    onSuccess: changed,
    onError,
  });
  const [editingScope, setEditingScope] = useState<string | null>(null);
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/spaces/${id}/members/${userId}`),
    onSuccess: async (_r, userId) => {
      if (userId === user?.id) {
        // Left the space: it is gone from the picker, and so is this page.
        await refresh();
        router.push('/');
        return;
      }
      await changed();
    },
    onError,
  });
  const archive = useMutation({
    mutationFn: (to: 'archive' | 'unarchive') => api.post<Space>(`/spaces/${id}/${to}`),
    onSuccess: changed,
    onError,
  });
  const purge = useMutation({
    mutationFn: () => api.delete(`/spaces/${id}`),
    onSuccess: async () => {
      await refresh();
      router.push('/');
    },
    onError,
  });

  if (spaceQ.isLoading) return <div className="p-8 font-mono text-on-surface-variant">loading…</div>;
  if (spaceQ.error || !space) {
    return (
      <div className="p-8 font-mono text-on-surface-variant" data-testid="space-missing">
        This space does not exist, or you are not a member of it.
      </div>
    );
  }

  const members = membersQ.data?.members ?? [];
  const activity = activityQ.data?.pages.flatMap((p) => p.activity) ?? [];

  return (
    <div className="space-y-8 max-w-4xl font-mono">
      <PageHeader
        title={`spaces/${space.slug}`}
        description={`a shared space · ${space.memberCount} ${space.memberCount === 1 ? 'member' : 'members'} · each member's agent runs are their own`}
        badge={<RoleBadge role={space.role} />}
      />

      {error && (
        <div role="alert" className="px-3 py-2 border border-error/40 bg-error/10 rounded-xs text-[12px] text-error">
          ! {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      <section aria-label="Name" className="space-y-2">
        <h2 className="section-label">name</h2>
        {isOwner && !archived ? (
          <RenameForm key={space.name} name={space.name} saving={rename.isPending} onSave={(n) => rename.mutate(n)} />
        ) : (
          <p className="text-[14px] text-on-surface" data-testid="space-name">{space.name}</p>
        )}
      </section>

      <section aria-label="Members" className="space-y-2">
        <h2 className="section-label">members</h2>
        <div className="term-frame rounded-xs divide-y divide-outline-variant/20">
          {members.map((m) => {
            const self = m.userId === user?.id;
            return (
              <div key={m.userId} data-testid="space-member">
              <div className="flex items-center gap-3 px-3 py-2">
                <span className="text-[13px] text-on-surface flex-1 min-w-0 truncate">
                  {m.username}
                  {self && <span className="ml-1.5 text-outline-variant">(you)</span>}
                </span>
                <span className="text-[11px] text-on-surface-variant hidden sm:inline">
                  joined {new Date(m.joinedAt).toLocaleDateString()}
                </span>
                {isOwner ? (
                  <select
                    value={m.role}
                    aria-label={`Role of ${m.username}`}
                    disabled={setRole.isPending}
                    onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value as SpaceRole })}
                    className={inputClass}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                ) : (
                  <RoleBadge role={m.role} />
                )}
                {isOwner && !self && (
                  <button
                    type="button"
                    aria-label={`Remove ${m.username}`}
                    title="Remove from the space"
                    onClick={() => window.confirm(`Remove ${m.username} from ${space.name}?`) && removeMember.mutate(m.userId)}
                    className="text-on-surface-variant hover:text-error cursor-pointer"
                  >
                    <UserMinus className="w-4 h-4" />
                  </button>
                )}
                {self && (
                  <button
                    type="button"
                    onClick={() => window.confirm(`Leave ${space.name}?`) && removeMember.mutate(m.userId)}
                    className={buttonClass}
                  >
                    <LogOut className="w-3.5 h-3.5" /> leave
                  </button>
                )}
              </div>
              {isOwner && m.role === 'guest' && (
                <div className="px-3 pb-2 space-y-2">
                  <p className="text-[11px] text-on-surface-variant" data-testid="guest-scope-summary">
                    sees {describeScope(m.scope)}
                    {!archived && (
                      <button
                        type="button"
                        onClick={() => setEditingScope(editingScope === m.userId ? null : m.userId)}
                        className="ml-2 text-primary hover:underline cursor-pointer"
                      >
                        {editingScope === m.userId ? 'cancel' : 'edit access'}
                      </button>
                    )}
                  </p>
                  {editingScope === m.userId && (
                    <GuestScopeForm
                      spaceId={space.id}
                      initial={m.scope ?? { rooms: [], folders: [] }}
                      saving={setRole.isPending}
                      onSave={(scope) => setRole.mutate(
                        { userId: m.userId, role: 'guest', scope },
                        { onSuccess: () => setEditingScope(null) },
                      )}
                    />
                  )}
                </div>
              )}
              </div>
            );
          })}
        </div>
      </section>

      {isOwner && !archived && (
        <section aria-label="Invites" className="space-y-2">
          <h2 className="section-label">invites</h2>
          <InviteForm spaceId={space.id} onCreated={changed} onError={onError} />
          <div className="term-frame rounded-xs divide-y divide-outline-variant/20">
            {(invitesQ.data?.invites ?? []).length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-on-surface-variant">no invites yet</p>
            ) : (
              (invitesQ.data?.invites ?? []).map((inv) => (
                <InviteRow key={inv.id} spaceId={space.id} invite={inv} onRevoked={changed} onError={onError} />
              ))
            )}
          </div>
        </section>
      )}

      <section aria-label="Activity" className="space-y-2">
        <h2 className="section-label">activity</h2>
        <div className="term-frame rounded-xs divide-y divide-outline-variant/20" data-testid="space-activity">
          {activity.length === 0 && !activityQ.isLoading && (
            <p className="px-3 py-3 text-[12px] text-on-surface-variant">nothing yet</p>
          )}
          {activity.map((a) => (
            <div key={a.id} className="flex items-baseline gap-3 px-3 py-1.5 text-[12px]">
              <span className="text-on-surface-variant shrink-0 w-40">{new Date(a.createdAt).toLocaleString()}</span>
              <span className="text-on-surface">{a.username ?? 'someone'}</span>
              <span className="text-on-surface-variant">{activityLabel(a.action)}</span>
              {typeof a.details?.role === 'string' && <span className="text-primary">{a.details.role}</span>}
            </div>
          ))}
        </div>
        {activityQ.hasNextPage && (
          <button type="button" onClick={() => activityQ.fetchNextPage()} disabled={activityQ.isFetchingNextPage} className={buttonClass}>
            older…
          </button>
        )}
      </section>

      {isOwner && (
        <section aria-label="Archive and delete" className="space-y-3">
          <h2 className="section-label">archive</h2>
          {archived ? (
            <>
              <p className="text-[12px] text-on-surface-variant">
                archived {new Date(space.archivedAt!).toLocaleString()}. everything is read-only and no agent runs here.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => archive.mutate('unarchive')} disabled={archive.isPending} className={buttonClass}>
                  <ArchiveRestore className="w-3.5 h-3.5" /> unarchive
                </button>
                <button
                  type="button"
                  onClick={() =>
                    window.confirm(`Delete ${space.name} and everything in it for good? This cannot be undone.`) && purge.mutate()
                  }
                  disabled={purge.isPending}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-xs border border-error/60 text-error hover:bg-error/10 disabled:opacity-50 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" /> delete for good
                </button>
              </div>
              <p className="text-[11px] text-outline-variant">
                a space can be deleted once it has been archived for the configured number of days.
              </p>
            </>
          ) : (
            <>
              <p className="text-[12px] text-on-surface-variant">
                archiving makes the space read-only for everyone and stops its agents. you can unarchive it later.
              </p>
              <button
                type="button"
                onClick={() => window.confirm(`Archive ${space.name}?`) && archive.mutate('archive')}
                disabled={archive.isPending}
                className={buttonClass}
              >
                <Archive className="w-3.5 h-3.5" /> archive
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function RenameForm({ name, saving, onSave }: { name: string; saving: boolean; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  const trimmed = draft.trim();
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label="Space name"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && trimmed && trimmed !== name && onSave(trimmed)}
        className={`${inputClass} w-72`}
      />
      <button type="button" disabled={saving || !trimmed || trimmed === name} onClick={() => onSave(trimmed)} className={primaryClass}>
        <Check className="w-3.5 h-3.5" /> rename
      </button>
    </div>
  );
}

/** Create an invite; its link is shown once, here (the server keeps only a hash). */
function InviteForm({ spaceId, onCreated, onError }: { spaceId: string; onCreated: () => Promise<void>; onError: (e: Error) => void }) {
  const [role, setRole] = useState<Invite['role']>('editor');
  const [hours, setHours] = useState(24 * 7);
  const [maxUses, setMaxUses] = useState(1);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // A guest joins with the rooms and folders picked here (S6).
  const [scope, setScope] = useState<GuestScope>({ rooms: [], folders: [] });

  const create = useMutation({
    mutationFn: () => api.post<CreatedInvite>(`/spaces/${spaceId}/invites`, role === 'guest'
      ? { role, scope, expiresInHours: hours, maxUses }
      : { role, expiresInHours: hours, maxUses }),
    onSuccess: async (inv) => {
      setLink(`${window.location.origin}/join/${inv.token}`);
      setCopied(false);
      await onCreated();
    },
    onError,
  });

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch (err) {
      onError(new Error(`Could not copy the link: ${(err as Error).message}. Select it and copy it by hand.`));
    }
  };

  return (
    <div className="term-frame rounded-xs p-3 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-outline-variant">
          role
          <select aria-label="Invite role" value={role} onChange={(e) => setRole(e.target.value as Invite['role'])} className={inputClass}>
            {INVITABLE.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-outline-variant">
          expires after
          <select aria-label="Invite expiry" value={hours} onChange={(e) => setHours(Number(e.target.value))} className={inputClass}>
            {EXPIRY_HOURS.map((o) => <option key={o.hours} value={o.hours}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-outline-variant">
          uses
          <input
            aria-label="Invite uses"
            type="number"
            min={1}
            max={100}
            value={maxUses}
            onChange={(e) => setMaxUses(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
            className={`${inputClass} w-20`}
          />
        </label>
        <button type="button" onClick={() => create.mutate()} disabled={create.isPending} className={primaryClass}>
          <Link2 className="w-3.5 h-3.5" /> create invite link
        </button>
      </div>
      {role === 'guest' && <GuestScopeFields spaceId={spaceId} value={scope} onChange={setScope} />}
      {link && (
        <div className="space-y-1" data-testid="invite-link">
          <p className="text-[11px] text-on-surface-variant">
            share this link — it is shown only now. anyone who opens it can join as {role} until it expires or is used up
            {role === 'guest' && <>, and will see {describeScope(scope)}</>}.
          </p>
          <div className="flex items-center gap-2">
            <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} className={`${inputClass} flex-1 text-[12px]`} />
            <button type="button" onClick={copy} className={buttonClass}>
              {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'copied' : 'copy link'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function InviteRow({ spaceId, invite, onRevoked, onError }: { spaceId: string; invite: Invite; onRevoked: () => Promise<void>; onError: (e: Error) => void }) {
  const revoke = useMutation({
    mutationFn: () => api.delete(`/spaces/${spaceId}/invites/${invite.id}`),
    onSuccess: onRevoked,
    onError,
  });
  // Judged once, when the list is read (each change re-reads it).
  const [readAt] = useState(() => Date.now());
  const expired = new Date(invite.expiresAt).getTime() <= readAt;
  const usedUp = invite.useCount >= invite.maxUses;
  const state = invite.revokedAt ? 'revoked' : expired ? 'expired' : usedUp ? 'used up' : 'active';
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-[12px]" data-testid="space-invite">
      <RoleBadge role={invite.role} />
      <span className="text-on-surface-variant">
        {invite.useCount}/{invite.maxUses} used · expires {new Date(invite.expiresAt).toLocaleString()}
        {invite.createdByName && <> · by {invite.createdByName}</>}
      </span>
      <span className={state === 'active' ? 'text-primary' : 'text-outline-variant'}>{state}</span>
      <span className="flex-1" />
      {state === 'active' && (
        <button type="button" onClick={() => revoke.mutate()} disabled={revoke.isPending} className={buttonClass}>
          revoke
        </button>
      )}
    </div>
  );
}

/** A guest scope in words: which rooms and folders. */
function describeScope(scope: GuestScope | null | undefined): string {
  const rooms = scope?.rooms.length ?? 0;
  const folders = scope?.folders ?? [];
  if (rooms === 0 && folders.length === 0) return 'nothing yet';
  const parts: string[] = [];
  if (rooms > 0) parts.push(`${rooms} room${rooms === 1 ? '' : 's'}`);
  if (folders.length > 0) parts.push(`folder${folders.length === 1 ? '' : 's'} ${folders.join(', ')}`);
  return parts.join(' and ');
}

/**
 * The rooms and folders a guest reaches (S6, docs/SPACES.md → Guests):
 * rooms by checkbox; folders as paths of the space's files, one per line —
 * the notes whose slug lies under a folder are in it too.
 */
function GuestScopeFields({ spaceId, value, onChange }: { spaceId: string; value: GuestScope; onChange: (scope: GuestScope) => void }) {
  const rooms = useRooms(spaceId);
  const [folderText, setFolderText] = useState(value.folders.join('\n'));
  const toggleRoom = (roomId: string, on: boolean) =>
    onChange({ ...value, rooms: on ? [...value.rooms, roomId] : value.rooms.filter((r) => r !== roomId) });
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="guest-scope">
      <fieldset className="space-y-1">
        <legend className="text-[10px] uppercase tracking-wider text-outline-variant mb-1">rooms the guest enters</legend>
        {(rooms.data ?? []).length === 0 ? (
          <p className="text-[12px] text-on-surface-variant">no rooms yet</p>
        ) : (
          (rooms.data ?? []).map((room) => (
            <label key={room.id} className="flex items-center gap-2 text-[12px] text-on-surface cursor-pointer">
              <input
                type="checkbox"
                aria-label={`Guest room ${room.title}`}
                checked={value.rooms.includes(room.id)}
                onChange={(e) => toggleRoom(room.id, e.target.checked)}
              />
              {room.title}
              {room.visibility === 'private' && <span className="text-outline-variant">(private)</span>}
            </label>
          ))
        )}
      </fieldset>
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-outline-variant">
        folders the guest reads (one per line)
        <textarea
          aria-label="Guest folders"
          rows={3}
          value={folderText}
          placeholder={'client/brief\nshared'}
          onChange={(e) => {
            setFolderText(e.target.value);
            onChange({ ...value, folders: e.target.value.split('\n').map((f) => f.trim()).filter(Boolean) });
          }}
          className={`${inputClass} normal-case tracking-normal`}
        />
      </label>
    </div>
  );
}

/** Edit an existing guest's scope. */
function GuestScopeForm({ spaceId, initial, saving, onSave }: { spaceId: string; initial: GuestScope; saving: boolean; onSave: (scope: GuestScope) => void }) {
  const [scope, setScope] = useState<GuestScope>(initial);
  return (
    <div className="term-frame rounded-xs p-3 space-y-2">
      <GuestScopeFields spaceId={spaceId} value={scope} onChange={setScope} />
      <button type="button" onClick={() => onSave(scope)} disabled={saving} className={primaryClass}>
        <Check className="w-3.5 h-3.5" /> save access
      </button>
    </div>
  );
}
