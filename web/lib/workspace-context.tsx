'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
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

export interface Org {
  id: string;
  slug: string;
  name: string;
  role?: string;
}

interface WorkspaceContextValue {
  workspaces: Workspace[];
  orgs: Org[];
  activeWorkspace: Workspace | null;
  isLoading: boolean;
  /** True when the multi-user feature flag is off — pickers should hide. */
  disabled: boolean;
  switchWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
  createWorkspace: (input: { slug: string; name: string; isDefault?: boolean }) => Promise<Workspace>;
}

const STORAGE_KEY = 'octipus.activeWorkspace';

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  orgs: [],
  activeWorkspace: null,
  isLoading: true,
  disabled: false,
  switchWorkspace: () => {},
  refresh: async () => {},
  createWorkspace: async () => {
    throw new Error('WorkspaceProvider missing');
  },
});

export function useWorkspace() {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setWorkspaces([]);
      setOrgs([]);
      setActiveId(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      // Don't send the workspace header on these — we're discovering it.
      const [wsRes, orgRes] = await Promise.all([
        api.get<{ workspaces: Workspace[] }>('/me/workspaces').catch((err) => {
          if (String(err?.message || '').includes('404')) {
            setDisabled(true);
            return { workspaces: [] };
          }
          throw err;
        }),
        api.get<{ orgs: Org[] }>('/me/orgs').catch(() => ({ orgs: [] })),
      ]);
      setWorkspaces(wsRes.workspaces);
      setOrgs(orgRes.orgs);

      const stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      const next =
        wsRes.workspaces.find((w) => w.id === stored) ??
        wsRes.workspaces.find((w) => w.isDefault) ??
        wsRes.workspaces[0] ??
        null;
      setActiveId(next?.id ?? null);
      if (next && typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, next.id);
      }
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (authLoading) return;
    refresh();
  }, [authLoading, refresh]);

  const switchWorkspace = useCallback((id: string) => {
    setActiveId(id);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, id);
    }
  }, []);

  const createWorkspace = useCallback(
    async (input: { slug: string; name: string; isDefault?: boolean }) => {
      const ws = await api.post<Workspace>('/me/workspaces', input);
      setWorkspaces((prev) => [...prev, ws]);
      switchWorkspace(ws.id);
      return ws;
    },
    [switchWorkspace],
  );

  const activeWorkspace = workspaces.find((w) => w.id === activeId) ?? null;

  // Expose the active slug to the API client for header injection.
  useEffect(() => {
    api.setWorkspaceSlug(activeWorkspace?.slug ?? null);
  }, [activeWorkspace]);

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        orgs,
        activeWorkspace,
        isLoading,
        disabled,
        switchWorkspace,
        refresh,
        createWorkspace,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
