'use client';

import {
  BookOpen,
  Bot,
  ClipboardList,
  Contact,
  Database,
  FolderKanban,
  Brain,
  CalendarDays,
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
  Puzzle,
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
import { useCompanionChat } from '@/hooks/useCompanionChat';
import { useSearchParams } from 'next/navigation';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { usePageOn } from '@/lib/modules';
import { pluginPageHref, usePluginPages } from '@/lib/plugin-pages';
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
    { name: 'Workspace', href: '/', icon: LayoutDashboard },
    { name: 'Sessions', href: '/chat', icon: MessageSquare },
    { name: 'Companion', href: '/companion', icon: Sparkles },
    { name: 'To-dos', href: '/tasks', icon: ListTodo },
    { name: 'Activity', href: '/notifications', icon: Bell },
  ] },
  // Everything that runs agents, whoever starts them (docs/MISSION-CONTROL.md).
  { label: 'Automation', items: [
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
    { name: 'Outputs', href: '/my-work', icon: ClipboardList },
    { name: 'notes', href: '/notes', icon: NotebookPen },
    { name: 'documents', href: '/documents', icon: FileText },
    { name: 'knowledge', href: '/knowledge', icon: Brain },
    { name: 'recall', href: '/recall', icon: Sparkles },
    { name: 'artifacts', href: '/artifacts', icon: Globe, badge: 'BETA' },
  ] },
  { label: 'Mail & calendar', items: [
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

/** The icons a plugin page may name (`ui.pages[].icon`); any other name shows the puzzle piece. */
const PLUGIN_ICONS: Record<string, typeof LayoutDashboard> = {
  'book-open': BookOpen, bot: Bot, brain: Brain, 'calendar-days': CalendarDays, 'clipboard-list': ClipboardList,
  contact: Contact, database: Database, 'file-text': FileText, 'folder-kanban': FolderKanban, globe: Globe,
  'layout-dashboard': LayoutDashboard, 'list-todo': ListTodo, mail: Mail, newspaper: Newspaper, 'notebook-pen': NotebookPen,
  puzzle: Puzzle, sparkles: Sparkles, telescope: Telescope, users: Users, wrench: Wrench, zap: Zap,
};

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { collapsed, toggle, groups: expanded, toggleGroup } = useSidebarStore();
  const companion = useCompanionChat();
  const sessionId = useSearchParams().get('session');
  const companionActive = !!companion.data?.supervisorSessionId && sessionId === companion.data.supervisorSessionId && pathname === '/chat';
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
  // Pages of the enabled plugin packages (docs/PLUGIN-PACKAGES.md#pages), as their own group.
  const pluginPages = usePluginPages(!!user);
  const pluginGroup: NavGroup | null = (pluginPages.data ?? []).length > 0
    ? { label: 'Plugins', items: (pluginPages.data ?? []).map((p) => ({ name: p.title, href: pluginPageHref(p), icon: PLUGIN_ICONS[p.icon ?? ''] ?? Puzzle })) }
    : null;
  const groups = [...navGroups.filter(group => group.label !== 'Settings'), ...(pluginGroup ? [pluginGroup] : [])].map(g => ({ ...g, items: g.items.filter(item => (!item.adminOnly || user?.isAdmin) && !offPage(item.href)) })).map(group => {
    if (group.label === 'Automation' && pulse) {
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
    .filter((href) => href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`) )
    .sort((a, b) => b.length - a.length)[0];

  const settingsActive = ['/settings', '/models', '/mcp', '/tools', '/permissions', '/persona', '/profiles', '/memory', '/skills', '/topics', '/eval', '/secrets', '/admin'].some(path => pathname === path || pathname.startsWith(`${path}/`));
  return (
    <>
    <button type="button" className="mobile-nav-toggle" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} onClick={() => { if (!mobileOpen && collapsed) toggle(); setMobileOpen(!mobileOpen); }}><PanelLeft size={20} /></button>
    <aside
      className={cn(
        'app-sidebar flex flex-col bg-surface-container-lowest border-r border-outline-variant/40 transition-[width] duration-200 ease-out shrink-0 font-sans',
        collapsed ? 'w-[76px]' : 'w-56', mobileOpen && 'mobile-open'
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
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
      </div>

      {/* User-controlled supporting groups retain their state across routes. */}
      <nav onClick={event => { if (event.target instanceof Element && event.target.closest('a')) setMobileOpen(false); }} className="flex-1 overflow-y-auto py-3 px-1.5 space-y-3">
        {groups.map((group) => (
          <details key={group.label} className={`group/nav ${group.label === 'Work' ? 'primary-nav' : ''} ${group.items.some(item => item.href === activeHref) ? 'nav-group-current' : ''}`} open={group.label === 'Work' || !!expanded[group.label]}>
            <summary onClick={event => { event.preventDefault(); toggleGroup(group.label); }} className="px-2 py-2 text-xs cursor-pointer text-on-surface hover:text-primary" title={group.label}>
              {collapsed ? group.label.slice(0, 1) : group.label}
              {/* Shown on the heading too, so a folded Agents group still says something is working. */}
              {!collapsed && group.items.some((i) => i.pulse) && <span className="float-right group-open/nav:hidden"><PulseChips pulse={group.items.find((i) => i.pulse)!.pulse!} heading /></span>}
            </summary>
            <div>
              {group.items.map((item) => {
                const isActive = item.href === '/companion' ? companionActive || pathname === '/companion' : item.href === '/chat' ? !companionActive && item.href === activeHref : item.href === activeHref;
                return (
                  <Link
                    key={item.name}
                    href={item.href === '/companion' && companion.data?.supervisorSessionId ? `/chat?session=${encodeURIComponent(companion.data.supervisorSessionId)}` : item.href}
                    title={collapsed ? item.name : undefined} aria-label={item.name}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'app-nav-item group relative flex items-center gap-2 text-[13px] transition-colors',
                      item.href === '/companion' && 'companion-nav-item',
                      collapsed
                        ? 'justify-center px-2 py-2 rounded-lg'
                        : 'px-2 py-1.5 rounded-lg',
                      isActive
                        ? 'nav-selected'
                        : 'border border-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low'
                    )}
                  >
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

      <Link href="/settings" onClick={() => setMobileOpen(false)} className={`app-nav-item settings-nav-anchor flex items-center gap-3 p-3 m-2 rounded-lg ${settingsActive ? 'nav-selected' : ''}`} aria-label="Settings" aria-current={pathname === '/settings' ? 'page' : undefined} title={collapsed ? 'Settings' : undefined}><Settings size={17} aria-hidden />{!collapsed && <span>Settings</span>}</Link>
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
