'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { initials, type Room, type RoomMember, roomsKey, type SpaceMemoryEntry, type RoomVisibility, useSpaceMembers } from '@/lib/rooms';
import { type RemoteMember, remotePath } from '@/lib/remote-spaces';
import type { RoomModeName, RoomModeView } from '../../../src/shared/types';

const inputClass = 'w-full px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[12px] text-on-surface focus:outline-none focus:border-primary';
const buttonClass = 'inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-50 cursor-pointer';

export const roomMembersKey = (roomId: string) => ['room', roomId, 'members'] as const;

/** The room's members (`GET …/rooms/:roomId/members`): every member for an open room. */
export function useRoomMembers(spaceId: string, roomId: string, enabled = true) {
  return useQuery({
    queryKey: roomMembersKey(roomId),
    queryFn: () => api.get<{ members: RoomMember[] }>(`/spaces/${spaceId}/rooms/${roomId}/members`).then((r) => r.members),
    enabled,
  });
}

/** The members of a space on another install, as its host lists them (display names, roles). */
export function useRemoteMembers(remoteSpaceId: string | null) {
  return useQuery({
    queryKey: ['remote-members', remoteSpaceId],
    queryFn: () => api.get<{ members: RemoteMember[] }>(remotePath(remoteSpaceId as string, '/members')).then((r) => r.members),
    enabled: !!remoteSpaceId,
  });
}

/**
 * The members of a space on another install: display names and roles, as
 * the host sends them (never usernames or e-mail, FI5). Members who are on
 * yet another install say so; nothing here can be managed.
 */
export function RemoteMembersPanel({ members, error }: { members: RemoteMember[]; error: string | null }) {
  return (
    <div className="space-y-2" data-testid="remote-members">
      <PanelError error={error} />
      <ul className="space-y-1">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 text-[12px]">
            <span className="h-5 w-5 rounded-full bg-surface-container-highest flex items-center justify-center text-[8px] font-semibold">{initials(m.displayName)}</span>
            <span className="truncate flex-1">{m.displayName || 'a member'}</span>
            {m.remote && <span className="text-[10px] text-outline-variant" title="A member from another install">other install</span>}
            <span className="text-[10px] text-on-surface-variant">{m.role}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PanelError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="px-2 py-1 border border-error/40 bg-error/10 rounded-xs text-[11px] text-error">! {error}</p>;
}

/**
 * Who is in the room. A private room's creator and the space's owners add
 * and remove its members (members of the space only); an open room holds
 * every member of the space.
 */
export function MembersPanel({ spaceId, room, canManage }: { spaceId: string; room: Room; canManage: boolean }) {
  const qc = useQueryClient();
  const members = useRoomMembers(spaceId, room.id);
  const spaceMembers = useSpaceMembers(room.visibility === 'private' && canManage ? spaceId : null);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const manage = canManage && room.visibility === 'private';

  const changed = async () => {
    setError(null);
    setAdding('');
    await qc.invalidateQueries({ queryKey: roomMembersKey(room.id) });
  };
  const add = useMutation({
    mutationFn: (userId: string) => api.post(`/spaces/${spaceId}/rooms/${room.id}/members/${userId}`),
    onSuccess: changed,
    onError: (err: Error) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/spaces/${spaceId}/rooms/${room.id}/members/${userId}`),
    onSuccess: changed,
    onError: (err: Error) => setError(err.message),
  });

  const inRoom = new Set((members.data ?? []).map((m) => m.userId));
  const addable = (spaceMembers.data ?? []).filter((m) => !inRoom.has(m.userId));

  return (
    <div className="space-y-2" data-testid="room-members-panel">
      <p className="text-[11px] text-on-surface-variant">
        {room.visibility === 'private' ? 'a private room: only the members below can enter it.' : 'an open room: every member of the space can enter it.'}
      </p>
      <PanelError error={error} />
      {members.isLoading && <p className="text-[11px] text-on-surface-variant">loading…</p>}
      {members.error && <PanelError error={(members.error as Error).message} />}
      <ul className="divide-y divide-outline-variant/20">
        {(members.data ?? []).map((m) => (
          <li key={m.userId} className="flex items-center gap-2 py-1.5 text-[12px]" data-testid="room-member">
            <span aria-hidden className="h-5 w-5 rounded-full bg-surface-container-highest flex items-center justify-center text-[9px] font-semibold">{initials(m.username)}</span>
            <span className="flex-1 truncate text-on-surface">{m.username}</span>
            {m.userId === room.createdBy && <span className="text-[10px] text-on-surface-variant">creator</span>}
            {manage && (
              <button
                type="button"
                aria-label={`Remove ${m.username} from the room`}
                onClick={() => window.confirm(`Remove ${m.username} from #${room.title}?`) && remove.mutate(m.userId)}
                disabled={remove.isPending}
                className="text-on-surface-variant hover:text-error cursor-pointer"
              >
                <UserMinus className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {manage && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => { e.preventDefault(); if (adding) add.mutate(adding); }}
        >
          <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a member" className={inputClass}>
            <option value="">add a member…</option>
            {addable.map((m) => <option key={m.userId} value={m.userId}>{m.username}</option>)}
          </select>
          <button type="submit" disabled={!adding || add.isPending} className={buttonClass}>
            <Plus className="w-3 h-3" /> add
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Space memory: short facts the members record for the space's agent,
 * given to every turn in the space. Members who may write add and retract
 * them; everyone reads them.
 */
export function MemoryPanel({ spaceId, canWrite }: { spaceId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const key = ['space', spaceId, 'memory'];
  const entries = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ entries: SpaceMemoryEntry[] }>(`/spaces/${spaceId}/memory`).then((r) => r.entries),
  });
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (text: string) => api.post<SpaceMemoryEntry>(`/spaces/${spaceId}/memory`, { body: text }),
    onSuccess: async () => {
      setBody('');
      setError(null);
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: (err: Error) => setError(err.message),
  });
  const retract = useMutation({
    mutationFn: (id: string) => api.delete(`/spaces/${spaceId}/memory/${id}`),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-2" data-testid="space-memory-panel">
      <p className="text-[11px] text-on-surface-variant">facts octipus is given in every chat and room of this space.</p>
      <PanelError error={error} />
      {canWrite && (
        <form className="space-y-1.5" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(body.trim()); }}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="e.g. we ship on Thursdays"
            aria-label="New space memory"
            className={`${inputClass} resize-none`}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-on-surface-variant">{body.length}/500</span>
            <button type="submit" disabled={!body.trim() || add.isPending} className={buttonClass}>
              <Plus className="w-3 h-3" /> remember
            </button>
          </div>
        </form>
      )}
      {entries.isLoading && <p className="text-[11px] text-on-surface-variant">loading…</p>}
      {entries.error && <PanelError error={(entries.error as Error).message} />}
      {entries.data?.length === 0 && <p className="text-[11px] text-on-surface-variant">nothing recorded yet</p>}
      <ul className="divide-y divide-outline-variant/20">
        {(entries.data ?? []).map((e) => (
          <li key={e.id} className="py-1.5 text-[12px] flex gap-2" data-testid="space-memory-entry">
            <div className="flex-1 min-w-0">
              <p className="text-on-surface whitespace-pre-wrap break-words">{e.body}</p>
              <p className="text-[10px] text-on-surface-variant">
                {e.authorKind === 'agent' ? `octipus for ${e.authorName ?? 'a member'}` : e.authorName ?? 'a former member'} · {new Date(e.createdAt).toLocaleDateString()}
              </p>
            </div>
            {canWrite && (
              <button
                type="button"
                aria-label="Retract this entry"
                title="Retract: octipus stops being given it at once"
                onClick={() => retract.mutate(e.id)}
                disabled={retract.isPending}
                className="text-on-surface-variant hover:text-error cursor-pointer self-start"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The room's settings: title and visibility, and its mode (§9.3). */
export function SettingsPanel({ spaceId, room, canManage }: { spaceId: string; room: Room; canManage: boolean }) {
  return (
    <div className="space-y-4">
      <TitlePanel spaceId={spaceId} room={room} canManage={canManage} />
      <ModePanel spaceId={spaceId} room={room} canManage={canManage} />
    </div>
  );
}

const MODE_HINTS: Record<RoomModeName, string> = {
  mention: 'speaks only when someone asks it (@octipus)',
  listen: 'offers help on a question nobody answered, without answering it',
  proactive: 'answers a question nobody answered, as the member who asked',
};

export const roomModeKey = (roomId: string) => ['room', roomId, 'mode'] as const;

/**
 * The room's mode (coworking spec §9.3): `listen` and `proactive` use the
 * group channels' gate — quiet hours, a daily cap, a minimum gap — and are
 * paid by the space's sponsor, so they stay silent in a space without one.
 */
function ModePanel({ spaceId, room, canManage }: { spaceId: string; room: Room; canManage: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const modeQ = useQuery({
    queryKey: roomModeKey(room.id),
    queryFn: () => api.get<RoomModeView>(`/spaces/${spaceId}/rooms/${room.id}/mode`),
  });
  const save = useMutation({
    mutationFn: (body: Partial<Pick<RoomModeView, 'mode' | 'quietHoursStart' | 'quietHoursEnd' | 'maxUnpromptedPerDay' | 'minMinutesBetween' | 'timezone'>>) =>
      api.put<RoomModeView>(`/spaces/${spaceId}/rooms/${room.id}/mode`, body),
    onSuccess: (view) => {
      setError(null);
      qc.setQueryData(roomModeKey(room.id), view);
    },
    onError: (err: Error) => setError(err.message),
  });
  const view = modeQ.data;
  if (!view) return null;
  const hour = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="space-y-2 text-[12px]" data-testid="room-mode-panel">
      <PanelError error={error} />
      <label className="block space-y-1">
        <span className="text-on-surface-variant">mode</span>
        {canManage ? (
          <select
            value={view.mode}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ mode: e.target.value as RoomModeName })}
            className={inputClass}
            aria-label="Room mode"
          >
            <option value="mention">mention</option>
            <option value="listen">listen</option>
            <option value="proactive">proactive</option>
          </select>
        ) : (
          <span className="block text-on-surface">{view.mode}</span>
        )}
      </label>
      <p className="text-[11px] text-on-surface-variant">{MODE_HINTS[view.mode]}</p>
      {view.mode !== 'mention' && (
        <>
          {canManage && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-on-surface-variant">quiet from (h)</span>
                <input
                  aria-label="Quiet hours start"
                  inputMode="numeric"
                  defaultValue={view.quietHoursStart ?? ''}
                  onBlur={(e) => hour(e.target.value) !== view.quietHoursStart && save.mutate({ quietHoursStart: hour(e.target.value) })}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-on-surface-variant">quiet until (h)</span>
                <input
                  aria-label="Quiet hours end"
                  inputMode="numeric"
                  defaultValue={view.quietHoursEnd ?? ''}
                  onBlur={(e) => hour(e.target.value) !== view.quietHoursEnd && save.mutate({ quietHoursEnd: hour(e.target.value) })}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-on-surface-variant">posts / day</span>
                <input
                  aria-label="Unprompted posts per day"
                  inputMode="numeric"
                  defaultValue={view.maxUnpromptedPerDay}
                  onBlur={(e) => Number(e.target.value) !== view.maxUnpromptedPerDay && save.mutate({ maxUnpromptedPerDay: Number(e.target.value) })}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-on-surface-variant">min gap (min)</span>
                <input
                  aria-label="Minutes between unprompted posts"
                  inputMode="numeric"
                  defaultValue={view.minMinutesBetween}
                  onBlur={(e) => Number(e.target.value) !== view.minMinutesBetween && save.mutate({ minMinutesBetween: Number(e.target.value) })}
                  className={inputClass}
                />
              </label>
            </div>
          )}
          <p className="text-[11px] text-on-surface-variant">
            {view.timezone} · feedback on unprompted posts: 👍 {view.feedback.up} · 👎 {view.feedback.down}
          </p>
        </>
      )}
    </div>
  );
}

/** The room's title and visibility: changed by its creator or a space owner, read by everyone. */
function TitlePanel({ spaceId, room, canManage }: { spaceId: string; room: Room; canManage: boolean }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(room.title);
  const [visibility, setVisibility] = useState<RoomVisibility>(room.visibility);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch<Room & { warning?: string }>(`/spaces/${spaceId}/rooms/${room.id}`, {
      ...(title.trim() !== room.title ? { title: title.trim() } : {}),
      ...(visibility !== room.visibility ? { visibility } : {}),
    }),
    onSuccess: async (updated) => {
      setError(null);
      setWarning(updated.warning ?? null);
      await qc.invalidateQueries({ queryKey: roomsKey(spaceId) });
      await qc.invalidateQueries({ queryKey: roomMembersKey(room.id) });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!canManage) {
    return (
      <div className="space-y-1 text-[12px]" data-testid="room-settings-panel">
        <p><span className="text-on-surface-variant">title</span> {room.title}</p>
        <p><span className="text-on-surface-variant">visibility</span> {room.visibility === 'private' ? 'private' : 'open to the space'}</p>
        <p className="text-[11px] text-on-surface-variant">only the room's creator or an owner of the space changes these.</p>
      </div>
    );
  }
  const dirty = (title.trim() && title.trim() !== room.title) || visibility !== room.visibility;
  return (
    <form
      className="space-y-2 text-[12px]"
      data-testid="room-settings-panel"
      onSubmit={(e) => { e.preventDefault(); if (dirty) save.mutate(); }}
    >
      <PanelError error={error} />
      {warning && <p role="status" className="text-[11px] text-warning">{warning}</p>}
      <label className="block space-y-1">
        <span className="text-on-surface-variant">title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className={inputClass} aria-label="Room title" />
      </label>
      <label className="block space-y-1">
        <span className="text-on-surface-variant">visibility</span>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as RoomVisibility)} className={inputClass} aria-label="Room visibility">
          <option value="space">open — every member of the space</option>
          <option value="private">private — members added to it</option>
        </select>
      </label>
      {visibility === 'private' && room.visibility === 'space' && (
        <p className="text-[11px] text-warning">only you and the room's creator stay in it; add the others under members.</p>
      )}
      <button type="submit" disabled={!dirty || save.isPending} className={buttonClass}>save</button>
    </form>
  );
}
