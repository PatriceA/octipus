'use client';

import {
  BookOpen,
  Bot,
  Brain,
  Cable,
  Cpu,
  FileText,
  Globe,
  Fingerprint,
  FlaskConical,
  GitBranch,
  GraduationCap,
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
  Tags,
  Telescope,
  Users,
  Webhook,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useSidebarStore } from '@/lib/sidebar-store';
import { cn } from '@/lib/utils';

interface NavItem {
  name: string;
  href: string;
  icon: typeof LayoutDashboard;
  badge?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  { label: 'Work', items: [
    { name: 'overview', href: '/', icon: LayoutDashboard },
    { name: 'chat', href: '/chat', icon: MessageSquare },
    { name: 'to-do', href: '/tasks', icon: ListTodo },
    { name: 'inbox', href: '/notifications', icon: Bell },
    { name: 'research', href: '/research', icon: Telescope },
    { name: 'agent activity', href: '/agents', icon: Bot },
  ] },
  { label: 'Library', items: [
    { name: 'notes', href: '/notes', icon: NotebookPen },
    { name: 'documents', href: '/documents', icon: FileText },
    { name: 'reader', href: '/reader', icon: Newspaper },
    { name: 'knowledge', href: '/knowledge', icon: Brain },
    { name: 'artifacts', href: '/artifacts', icon: Globe, badge: 'BETA' },
  ] },
  { label: 'Automations', items: [
    { name: 'pipelines', href: '/pipelines', icon: GitBranch },
    { name: 'hooks & schedules', href: '/hooks', icon: Webhook },
  ] },
  { label: 'Connections', items: [
    { name: 'models', href: '/models', icon: Cpu },
    { name: 'mcp & connectors', href: '/mcp', icon: Cable },
    { name: 'email', href: '/email', icon: Mail },
  ] },
  { label: 'Settings', items: [
    { name: 'settings & channels', href: '/settings', icon: Settings },
    { name: 'tools', href: '/tools', icon: Wrench },
    { name: 'scoped permissions', href: '/permissions', icon: KeyRound },
    { name: 'persona', href: '/persona', icon: Fingerprint },
    { name: 'people & profiles', href: '/profiles', icon: Users },
    { name: 'memory', href: '/memory', icon: Brain },
    { name: 'experts', href: '/experts', icon: GraduationCap },
    { name: 'skills', href: '/skills', icon: BookOpen },
    { name: 'topics', href: '/topics', icon: Tags },
    { name: 'evaluations', href: '/eval', icon: FlaskConical },
    { name: 'secrets', href: '/secrets', icon: KeyRound },
  ] },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { collapsed, toggle } = useSidebarStore();
  const { user } = useAuth();
  const groups = navGroups.map(group => group.label === 'Settings' && user?.isAdmin
    ? { ...group, items: [...group.items, { name: 'users', href: '/admin/users', icon: Users }] } : group);

  return (
    <>
    <button type="button" className="mobile-nav-toggle" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} onClick={() => { if (!mobileOpen && collapsed) toggle(); setMobileOpen(!mobileOpen); }}><PanelLeft size={20} /></button>
    <aside
      className={cn(
        'app-sidebar flex flex-col bg-surface-container-lowest border-r border-outline-variant/40 transition-[width] duration-200 ease-out shrink-0 font-sans',
        collapsed ? 'w-14' : 'w-60', mobileOpen && 'mobile-open'
      )}
    >
      {/* Brand row — small square logo + word "octipus", with a TUI
          status dot showing the gateway is connected. Logo intentionally
          flat (no gradient) so it reads as an icon in a terminal grid. */}
      <div className="h-12 flex items-center justify-between px-3 shrink-0 border-b border-outline-variant/40">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="w-8 h-8 flex items-center justify-center shrink-0">
            <img src="/logo.png" alt="Octipus" className="w-8 h-8 object-contain" />
          </div>
          {!collapsed && (
            <span className="text-sm font-bold text-on-surface whitespace-nowrap">
              Octipus
            </span>
          )}
        </div>
        <button
          onClick={toggle}
          className="p-1 text-on-surface-variant hover:text-primary hover:bg-surface-container rounded-xs cursor-pointer shrink-0 transition-colors"
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
          <details key={`${group.label}:${collapsed}`} open={group.items.some(item => item.href === '/' ? pathname === '/' : pathname.startsWith(item.href))}>
            <summary className="px-2 py-2 text-xs cursor-pointer text-on-surface hover:text-primary" title={group.label}>
              {collapsed ? group.label.slice(0, 1) : group.label}
            </summary>
            <div>
              {group.items.map((item) => {
                const isActive =
                  item.href === '/'
                    ? pathname === '/'
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    title={collapsed ? item.name : undefined}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-2 text-[13px] transition-colors',
                      collapsed
                        ? 'justify-center px-2 py-2 rounded-xs'
                        : 'px-2 py-1.5 rounded-xs',
                      isActive
                        ? 'text-primary bg-primary-container/40 border border-primary/30 glow-accent'
                        : 'border border-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low'
                    )}
                  >
                    {/* TUI active marker — chevron in accent. Collapsed
                        view drops the marker since there's no room. */}
                    {!collapsed && (
                      <span
                        aria-hidden
                        className={cn(
                          'w-3 text-center text-primary',
                          isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'
                        )}
                      >
                        ❯
                      </span>
                    )}
                    <item.icon className="shrink-0 w-4 h-4" />
                    {!collapsed && <span className="truncate">{item.name}</span>}
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
