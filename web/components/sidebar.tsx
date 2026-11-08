'use client';

import {
  BookOpen,
  Bot,
  ClipboardList,
  Contact,
  Database,
  FolderKanban,
  Brain,
  Cable,
  CalendarDays,
  Cpu,
  FileText,
  Globe,
  Fingerprint,
  FlaskConical,
  GitBranch,
  Hash,
  KeyRound,
  LayoutDashboard,
  Bell,
  ListTodo,
  Mail,
  MessageSquare,
  Newspaper,
  NotebookPen,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Sparkles,
  Tags,
  Telescope,
  Users,
  Webhook,
  Wrench,
  Zap,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { usePageOn } from '@/lib/modules';
import { useRooms } from '@/lib/rooms';
import { useSidebarStore } from '@/lib/sidebar-store';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import type { AgentPulse } from '../../src/shared/agent-origin';

interface NavItem {
  name: string;
  href: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  /** Unread count (rooms), shown when above zero. */
  count?: number;
  /** Mission control's pulse: runs working now, and approvals waiting on the user. */
  pulse?: AgentPulse;
  /** Install configuration: shown to admins only (the routes behind it are admin-only). */
  adminOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  { label: 'Work', items: [
    { name: 'overview', href: '/', icon: LayoutDashboard },
    { name: 'chat', href: '/chat', icon: MessageSquare },
    { name: 'companion', href: '/companion', icon: Sparkles },
    { name: 'to-do', href: '/tasks', icon: ListTodo },
    { name: 'my work', href: '/my-work', icon: ClipboardList },
    { name: 'inbox', href: '/notifications', icon: Bell },
    { name: 'research', href: '/research', icon: Telescope },
  ] },
  // Everything that runs agents, whoever starts them (docs/MISSION-CONTROL.md).
  { label: 'Agents', items: [
    { name: 'mission control', href: '/agents', icon: Bot },
    { name: 'roster', href: '/agents/roster', icon: Users },
    { name: 'triggers', href: '/agents/triggers', icon: Zap },
    { name: 'pipelines', href: '/pipelines', icon: GitBranch },
    { name: 'hooks & schedules', href: '/hooks', icon: Webhook },
  ] },
  { label: 'Business', items: [
    { name: 'cases', href: '/cases', icon: FolderKanban },
    { name: 'contacts', href: '/contacts', icon: Contact },
    { name: 'records', href: '/records', icon: Database },
  ] },
  { label: 'Library', items: [
    { name: 'notes', href: '/notes', icon: NotebookPen },
    { name: 'documents', href: '/documents', icon: FileText },
    { name: 'reader', href: '/reader', icon: Newspaper },
    { name: 'knowledge', href: '/knowledge', icon: Brain },
    { name: 'recall', href: '/recall', icon: Sparkles },
    { name: 'artifacts', href: '/artifacts', icon: Globe, badge: 'BETA' },
  ] },
  { label: 'Connections', items: [
    { name: 'models', href: '/models', icon: Cpu },
    { name: 'mcp & connectors', href: '/mcp', icon: Cable },
    { name: 'email', href: '/email', icon: Mail },
    { name: 'mailboxes', href: '/mail', icon: Mail },
    { name: 'calendar', href: '/calendar', icon: CalendarDays },
  ] },
  { label: 'Settings', items: [
    { name: 'settings & channels', href: '/settings', icon: Settings },
    { name: 'tools', href: '/tools', icon: Wrench, adminOnly: true },
    { name: 'scoped permissions', href: '/permissions', icon: KeyRound },
    { name: 'persona', href: '/persona', icon: Fingerprint },
    { name: 'people & profiles', href: '/profiles', icon: Users },
    { name: 'memory', href: '/memory', icon: Brain },
    { name: 'skills', href: '/skills', icon: BookOpen },
    { name: 'topics', href: '/topics', icon: Tags, adminOnly: true },
    { name: 'evaluations', href: '/eval', icon: FlaskConical, adminOnly: true },
    { name: 'secrets', href: '/secrets', icon: KeyRound },
  ] },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { collapsed, toggle } = useSidebarStore();
  const { user } = useAuth();
  // In a shared space: its rooms, with what I have not read in them (muted rooms left out).
  const { activeWorkspace } = useWorkspace();
  const spaceId = activeWorkspace?.kind === 'shared' ? activeWorkspace.id : null;
  const rooms = useRooms(spaceId);
  const pulse = usePulse(!!user, activeWorkspace?.id ?? null);
  const unread = (rooms.data ?? []).reduce((sum, r) => sum + (r.muted ? 0 : r.unreadCount), 0);
  // Pages of a module that is off (docs/MODULES.md) are left out, and a
  // group left without pages goes too.
  const pageOn = usePageOn();
  const offPage = (href: string) => !pageOn(href);
  const groups = navGroups.map(g => ({ ...g, items: g.items.filter(item => (!item.adminOnly || user?.isAdmin) && !offPage(item.href)) })).map(group => {
    if (group.label === 'Settings' && user?.isAdmin) {
      return { ...group, items: [...group.items, { name: 'users', href: '/admin/users', icon: Users }] };
    }
    if (group.label === 'Agents' && pulse) {
      return { ...group, items: group.items.map((item) => item.href === '/agents' ? { ...item, pulse } : item) };
    }
    if (group.label === 'Work' && spaceId) {
      const items = [...group.items];
      items.splice(2, 0, { name: 'rooms', href: '/rooms', icon: Hash, count: unread });
      return { ...group, items };
    }
    // A space on another install (federation §8.3): its rooms and its files.
    if (group.label === 'Work' && activeWorkspace?.kind === 'remote') {
      const items = [...group.items];
      items.splice(2, 0, { name: 'rooms', href: '/rooms', icon: Hash }, { name: 'space files', href: '/spaces/remote', icon: FileText });
      return { ...group, items };
    }
    return group;
  }).filter((group) => group.items.length > 0);
  // The most specific item wins: /agents/triggers lights "triggers", not "mission control" too.
  const activeHref = groups.flatMap((g) => g.items.map((i) => i.href))
    .filter((href) => href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`) || pathname.startsWith(href))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <>
    <button type="button" className="mobile-nav-toggle" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} onClick={() => { if (!mobileOpen && collapsed) toggle(); setMobileOpen(!mobileOpen); }}><PanelLeft size={20} /></button>
    <aside
      className={cn(
        'app-sidebar flex flex-col bg-surface-container-lowest border-r border-outline-variant/40 transition-[width] duration-200 ease-out shrink-0 font-sans',
        collapsed ? 'w-14' : 'w-60', mobileOpen && 'mobile-open'
      )}
    >
      {/* A still product mark; personal companions belong to the work. */}
      <div className="h-12 flex items-center justify-between px-3 shrink-0 border-b border-outline-variant/40">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="w-8 h-8 flex items-center justify-center shrink-0">
            <img src="/companion-mark.svg" alt="Octipus" className="w-8 h-8 object-contain" />
          </div>
          {!collapsed && (
            <span className="text-sm font-bold text-on-surface whitespace-nowrap">
              Octipus
            </span>
          )}
        </div>
        <button
          onClick={toggle}
          className="p-1 text-on-surface-variant hover:text-primary hover:bg-surface-container rounded-lg cursor-pointer shrink-0 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
      </div>

      {/* Navigation. Group labels use the `// label` section style.
          Active item uses a `❯` left-marker rendered via ::before in CSS
          (here just rendered inline so it's keyboard-readable). */}
      <nav onClick={event => { if (event.target instanceof Element && event.target.closest('a')) setMobileOpen(false); }} className="flex-1 overflow-y-auto py-3 px-1.5 space-y-3">
        {groups.map((group) => (
          <details key={`${group.label}:${collapsed}`} className="group/nav" open={group.items.some(item => item.href === activeHref)}>
            <summary className="px-2 py-2 text-xs cursor-pointer text-on-surface hover:text-primary" title={group.label}>
              {collapsed ? group.label.slice(0, 1) : group.label}
              {/* Shown on the heading too, so a folded Agents group still says something is working. */}
              {!collapsed && group.items.some((i) => i.pulse) && <span className="float-right group-open/nav:hidden"><PulseChips pulse={group.items.find((i) => i.pulse)!.pulse!} heading /></span>}
            </summary>
            <div>
              {group.items.map((item) => {
                const isActive = item.href === activeHref;
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    title={collapsed ? item.name : undefined}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-2 text-[13px] transition-colors',
                      collapsed
                        ? 'justify-center px-2 py-2 rounded-lg'
                        : 'px-2 py-1.5 rounded-lg',
                      isActive
                        ? 'text-primary bg-primary-container/40 border border-primary/30'
                        : 'border border-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low'
                    )}
                  >
                    {/* Active marker — a quiet accent dot. Collapsed
                        view drops the marker since there's no room. */}
                    {!collapsed && (
                      <span
                        aria-hidden
                        className={cn(
                          'w-3 text-center text-primary',
                          isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'
                        )}
                      >
                        •
                      </span>
                    )}
                    <span className="relative shrink-0">
                      <item.icon className="w-4 h-4" />
                      {collapsed && item.pulse && (item.pulse.live > 0 || !!item.pulse.pendingApprovals) && (
                        <span aria-hidden className={cn('absolute -right-1 -top-1 h-2 w-2 rounded-full', item.pulse.pendingApprovals ? 'bg-accent' : 'bg-tertiary animate-pulse')} />
                      )}
                    </span>
                    {!collapsed && <span className="truncate">{item.name}</span>}
                    {!collapsed && !!item.count && (
                      <span data-testid={`nav-unread-${item.name}`} className="ml-auto rounded-sm bg-primary px-1.5 text-[10px] font-semibold text-on-primary">
                        {item.count}
                      </span>
                    )}
                    {!collapsed && item.pulse && <PulseChips pulse={item.pulse} />}
                    {!collapsed && item.badge && (
                      <span className="ml-auto rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-primary">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </details>
        ))}
      </nav>

      {/* User identity lives in the header profile dropdown (single source of
          truth); the duplicate sidebar card was removed per QA. */}
    </aside>
    </>
  );
}

/** Runs working now and approvals waiting, for the Mission control item. */
function usePulse(enabled: boolean, workspaceId: string | null): AgentPulse | undefined {
  const { data } = useQuery({
    queryKey: ['agent-pulse', workspaceId],
    enabled,
    queryFn: async () => {
      const r = await api.get<Partial<AgentPulse>>('/agents/pulse');
      return typeof r?.live === 'number' ? { live: r.live, pendingApprovals: typeof r.pendingApprovals === 'number' ? r.pendingApprovals : null } : undefined;
    },
    refetchInterval: 10_000,
    retry: false,
  });
  return data ?? undefined;
}

function PulseChips({ pulse, heading = false }: { pulse: AgentPulse; heading?: boolean }) {
  if (!pulse.live && !pulse.pendingApprovals) return null;
  return <span className={cn('flex items-center gap-1', !heading && 'ml-auto')}>
    {pulse.live > 0 && <span data-testid={heading ? undefined : 'nav-live-agents'} title={`${pulse.live} working now`} aria-label={`${pulse.live} working now`}
      className="inline-flex items-center gap-1 rounded-sm border border-tertiary/50 px-1 text-[10px] font-semibold text-tertiary">
      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-tertiary" />{pulse.live}
    </span>}
    {!!pulse.pendingApprovals && <span data-testid={heading ? undefined : 'nav-needs-you'} title={`${pulse.pendingApprovals} waiting on you`} aria-label={`${pulse.pendingApprovals} waiting on you`}
      className="rounded-sm bg-accent px-1.5 text-[10px] font-semibold text-on-accent">{pulse.pendingApprovals}</span>}
  </span>;
}
