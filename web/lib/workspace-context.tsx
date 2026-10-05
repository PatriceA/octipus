'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, WORKSPACE_DENIED_EVENT, type WorkspaceDeniedDetail } from './api';
import { useAuth } from './auth-context';

export interface Workspace {
  id: string;
  userId: string;
  slug: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SpaceRole = 'owner' | 'editor' | 'commenter' | 'viewer' | 'guest';

/** A shared space the caller is a member of (`GET /api/spaces`, `SpaceSummary` on the server). */
export interface Space {
  id: string;
  name: string;
  slug: string;
  /** The caller's role. */
  role: SpaceRole;
  memberCount: number;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Who pays for the agent (`workspaces.agent_funding`, coworking spec §9.1). */
  funding: AgentFundingMode;
  /** The owner who pays for sponsored work, or null. */
  sponsorUserId: string | null;
  /** The sponsor's own model rows sponsored turns may run on. */
  sponsorModels: string[];
}

export type AgentFundingMode = 'own' | 'unattended' | 'sponsored';

/** The selected workspace: one of the caller's own, or a space. */
export type ActiveWorkspace = ({ kind: 'personal' } & Workspace) | ({ kind: 'shared' } & Space);

/**
 * What the caller may do in the selected workspace (docs/SPACES.md → Roles).
 * In a personal workspace everything; in a space by role, and nothing but
 * reading while it is archived. The server enforces the same; this only
 * keeps the pages from offering what it would refuse.
 */
export interface WorkspaceAccess {
  /** The caller's role in the selected space; null in a personal workspace. */
  role: SpaceRole | null;
  archived: boolean;
  /** Create and edit notes, tasks, documents and files; upload. */
  canWrite: boolean;
  /** Comment on tasks. */
  canComment: boolean;
}

const PERSONAL_ACCESS: WorkspaceAccess = { role: null, archived: false, canWrite: true, canComment: true };

export function accessFor(space: Pick<Space, 'role' | 'archivedAt'>): WorkspaceAccess {
  const archived = space.archivedAt !== null;
  const writer = space.role === 'owner' || space.role === 'editor';
  return {
    role: space.role,
    archived,
    canWrite: writer && !archived,
    canComment: (writer || space.role === 'commenter' || space.role === 'guest') && !archived,
  };
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  role?: string;
}

interface WorkspaceContextValue {
  /** The caller's own workspaces. */
  workspaces: Workspace[];
  /** The shared spaces the caller is a member of. */
  spaces: Space[];
  orgs: Org[];
  activeWorkspace: ActiveWorkspace | null;
  /**
   * The personal workspace in effect: the selected one, or the default while
   * a space is selected. Personal-only pages (secrets) use it, since the
   * server runs their routes in the default personal workspace.
   */
  personalWorkspace: Workspace | null;
  access: WorkspaceAccess;
  isLoading: boolean;
  /** True when the multi-user feature flag is off — pickers should hide. */
  disabled: boolean;
  /** What the user should be told about the selection ("You no longer have access to …"). */
  notice: string | null;
  dismissNotice: () => void;
  switchWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
  createWorkspace: (input: { slug: string; name: string; isDefault?: boolean }) => Promise<Workspace>;
  /** Create a shared space (the caller becomes its owner) and switch to it. */
  createSpace: (name: string) => Promise<Space>;
}

const STORAGE_KEY = 'octipus.activeWorkspace';
/** The selected space's id and name, to name it if it is gone at the next load. */
const SPACE_KEY = 'octipus.activeSpace';

/**
 * Select `id` at the next workspace load, before the provider has read the
 * list: registering with an invite link (S6) joins a space and lands in it.
 */
export function rememberWorkspaceSelection(id: string): void {
  localStorage.setItem(STORAGE_KEY, id);
}

function lastSpace(): { id: string; name: string } | null {
  try {
    const raw = localStorage.getItem(SPACE_KEY);
    return raw ? (JSON.parse(raw) as { id: string; name: string }) : null;
  } catch (err) {
    console.warn('Unreadable remembered space', err);
    return null;
  }
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  spaces: [],
  orgs: [],
  activeWorkspace: null,
  personalWorkspace: null,
  access: PERSONAL_ACCESS,
  isLoading: true,
  disabled: false,
  notice: null,
  dismissNotice: () => {},
  switchWorkspace: () => {},
  refresh: async () => {},
  createWorkspace: async () => {
    throw new Error('WorkspaceProvider missing');
  },
  createSpace: async () => {
    throw new Error('WorkspaceProvider missing');
  },
});

export function useWorkspace() {
  return useContext(WorkspaceContext);
}

/**
 * The active workspace's id, for query keys of workspace-scoped data
 * (`['notes', workspaceId]`): data read under one workspace is never served
 * from the cache under another.
 */
export function useWorkspaceId(): string | null {
  return useContext(WorkspaceContext).activeWorkspace?.id ?? null;
}

/** What the caller may do in the selected workspace. */
export function useWorkspaceAccess(): WorkspaceAccess {
  return useContext(WorkspaceContext).access;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The selection as of the last change, for callbacks that outlive a render. */
  const activeIdRef = useRef<string | null>(null);

  const select = useCallback((id: string | null) => {
    // The header follows at once, before any request of the new render.
    api.setWorkspaceId(id);
    activeIdRef.current = id;
    setActiveId(id);
    if (typeof window !== 'undefined') {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      api.setWorkspaceId(null);
      activeIdRef.current = null;
      setWorkspaces([]);
      setSpaces([]);
      setOrgs([]);
      setActiveId(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      // `/me/workspaces` and `GET /spaces` answer whatever the workspace
      // header names (a removed member's client recovers through them).
      const [wsRes, orgRes, spaceRes] = await Promise.all([
        api.get<{ workspaces: Workspace[] }>('/me/workspaces').catch((err) => {
          if (String(err?.message || '').includes('404')) {
            setDisabled(true);
            return { workspaces: [] };
          }
          throw err;
        }),
        api.get<{ orgs: Org[] }>('/me/orgs').catch(() => ({ orgs: [] })),
        api.get<{ spaces: Space[] }>('/spaces'),
      ]);
      setWorkspaces(wsRes.workspaces);
      setSpaces(spaceRes.spaces);
      setOrgs(orgRes.orgs);

      // The selection survives a refresh while it still exists: one of the
      // caller's workspaces, or a space they are still a member of.
      const firstLoad = activeIdRef.current === null;
      const stored = activeIdRef.current ?? (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null);
      const next =
        wsRes.workspaces.find((w) => w.id === stored) ??
        spaceRes.spaces.find((sp) => sp.id === stored) ??
        wsRes.workspaces.find((w) => w.isDefault) ??
        wsRes.workspaces[0] ??
        null;
      // The space selected last time is gone (the user was removed while
      // away): say so, as a removal during the session does (below).
      if (firstLoad && stored && next?.id !== stored) {
        const last = lastSpace();
        if (last?.id === stored) setNotice(`You no longer have access to ${last.name}`);
      }
      const changed = activeIdRef.current !== null && next?.id !== activeIdRef.current;
      select(next?.id ?? null);
      if (changed) queryClient.clear();
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, queryClient, select]);

  useEffect(() => {
    if (authLoading) return;
    // Defer to a timer so the fetch's setState runs in the timer callback, not
    // synchronously in the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(refresh, 0);
    return () => clearTimeout(t);
  }, [authLoading, refresh]);

  /**
   * Switch synchronously: the API client's workspace header changes before
   * anything re-renders, then every cached query is dropped — so no request
   * leaves with the old header and no page shows the old workspace's data.
   */
  const switchWorkspace = useCallback((id: string) => {
    select(id);
    queryClient.clear();
  }, [queryClient, select]);

  const createWorkspace = useCallback(
    async (input: { slug: string; name: string; isDefault?: boolean }) => {
      const ws = await api.post<Workspace>('/me/workspaces', input);
      setWorkspaces((prev) => [...prev, ws]);
      switchWorkspace(ws.id);
      return ws;
    },
    [switchWorkspace],
  );

  const createSpace = useCallback(
    async (name: string) => {
      const space = await api.post<Space>('/spaces', { name });
      setSpaces((prev) => [...prev, space]);
      switchWorkspace(space.id);
      return space;
    },
    [switchWorkspace],
  );

  const activePersonal = workspaces.find((w) => w.id === activeId) ?? null;
  const listedSpace = activePersonal ? null : (spaces.find((sp) => sp.id === activeId) ?? null);

  // The caller's role in the selected space, read again on every switch and
  // when the window regains focus, so a role change shows without a reload.
  // A removed member's read answers 404 `workspace_denied`; the listener
  // below handles that.
  const spaceQuery = useQuery({
    queryKey: ['space', listedSpace?.id ?? null, 'detail'],
    queryFn: () => api.get<Space>(`/spaces/${listedSpace!.id}`),
    enabled: !!listedSpace,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const activeSpace = listedSpace && spaceQuery.data?.id === listedSpace.id ? spaceQuery.data : listedSpace;

  const activeWorkspace: ActiveWorkspace | null = activePersonal
    ? { kind: 'personal', ...activePersonal }
    : activeSpace
      ? { kind: 'shared', ...activeSpace }
      : null;
  useEffect(() => {
    if (activeSpace) localStorage.setItem(SPACE_KEY, JSON.stringify({ id: activeSpace.id, name: activeSpace.name }));
  }, [activeSpace]);

  const personalWorkspace = activePersonal ?? workspaces.find((w) => w.isDefault) ?? workspaces[0] ?? null;
  const access = activeSpace ? accessFor(activeSpace) : PERSONAL_ACCESS;

  // A space the caller is no longer a member of: the server answers 404
  // `workspace_denied` to any request naming it (lib/api.ts raises the
  // event). Back to the default workspace, saying why, and the list re-read.
  const listsRef = useRef({ spaces, workspaces });
  useEffect(() => {
    listsRef.current = { spaces, workspaces };
  }, [spaces, workspaces]);
  useEffect(() => {
    const onDenied = (e: Event) => {
      const { workspaceId } = (e as CustomEvent<WorkspaceDeniedDetail>).detail;
      if (workspaceId !== activeIdRef.current) return;
      const { spaces: known, workspaces: own } = listsRef.current;
      const lost = known.find((sp) => sp.id === workspaceId);
      setNotice(`You no longer have access to ${lost?.name ?? 'that space'}`);
      setSpaces((prev) => prev.filter((sp) => sp.id !== workspaceId));
      const fallback = own.find((w) => w.isDefault) ?? own[0] ?? null;
      select(fallback?.id ?? null);
      queryClient.clear();
      api.get<{ spaces: Space[] }>('/spaces')
        .then((res) => setSpaces(res.spaces))
        .catch((err) => console.warn('Could not re-read the space list', err));
    };
    window.addEventListener(WORKSPACE_DENIED_EVENT, onDenied);
    return () => window.removeEventListener(WORKSPACE_DENIED_EVENT, onDenied);
  }, [queryClient, select]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        spaces,
        orgs,
        activeWorkspace,
        personalWorkspace,
        access,
        isLoading,
        disabled,
        notice,
        dismissNotice,
        switchWorkspace,
        refresh,
        createWorkspace,
        createSpace,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
