import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SidebarState {
  collapsed: boolean;
  groups: Record<string, boolean>;
  toggleGroup: (name: string) => void;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      collapsed: false,
      groups: {},
      toggleGroup: (name) => set(s => ({ groups: { ...s.groups, [name]: !s.groups[name] } })),
      toggle: () => set((s) => ({ collapsed: !s.collapsed })),
      setCollapsed: (collapsed) => set({ collapsed }),
    }),
    { name: 'sidebar-state' }
  )
);
