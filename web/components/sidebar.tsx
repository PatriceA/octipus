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
  KeyRound,
  LayoutDashboard,
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
  {
    label: 'main',
    items: [
      { name: 'dashboard', href: '/', icon: LayoutDashboard },
      { name: 'chat', href: '/chat', icon: MessageSquare },
      { name: 'to-do', href: '/tasks', icon: ListTodo },
      { name: 'email', href: '/email', icon: Mail },
      { name: 'reader', href: '/reader', icon: Newspaper },
      { name: 'notes', href: '/notes', icon: NotebookPen },
      { name: 'documents', href: '/documents', icon: FileText },
      { name: 'profiles', href: '/profiles', icon: Users },
      { name: 'persona', href: '/persona', icon: Fingerprint },
    ],
  },
  {
    label: 'ai & automation',
    items: [
      { name: 'agents', href: '/agents', icon: Bot },
      { name: 'research', href: '/research', icon: Telescope },
      { name: 'models', href: '/models', icon: Cpu },
      { name: 'topics', href: '/topics', icon: Tags },
      { name: 'pipelines', href: '/pipelines', icon: GitBranch },
      { name: 'tools', href: '/tools', icon: Wrench },
      { name: 'skills', href: '/skills', icon: BookOpen },
      { name: 'knowledge', href: '/knowledge', icon: Brain },
      { name: 'memory', href: '/memory', icon: Brain },
      { name: 'evaluations', href: '/eval', icon: FlaskConical },
      { name: 'artifacts', href: '/artifacts', icon: Globe, badge: 'BETA' },
    ],
  },
  {
    label: 'system',
    items: [
      { name: 'mcp', href: '/mcp', icon: Cable },
      { name: 'hooks', href: '/hooks', icon: Webhook },
    ],
  },
  {
    label: 'admin',
    items: [
      { name: 'secrets', href: '/secrets', icon: KeyRound },
      { name: 'settings', href: '/settings', icon: Settings },
    ],
  },
];

const adminOnlyGroup: NavGroup = {
  label: 'multi-user',
  items: [
    { name: 'users', href: '/admin/users', icon: Users },
  ],
};

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebarStore();
  const { user } = useAuth();
  const groups = user?.isAdmin ? [...navGroups, adminOnlyGroup] : navGroups;

  return (
    <aside
      className={cn(
        'flex flex-col bg-surface-container-lowest border-r border-outline-variant/40 transition-[width] duration-200 ease-out shrink-0 font-mono',
        collapsed ? 'w-14' : 'w-60'
      )}
    >
      {/* Brand row — small square logo + word "octipus", with a TUI
          status dot showing the gateway is connected. Logo intentionally
          flat (no gradient) so it reads as an icon in a terminal grid. */}
      <div className="h-12 flex items-center justify-between px-3 shrink-0 border-b border-outline-variant/40">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="w-7 h-7 flex items-center justify-center shrink-0 bg-surface-container border border-outline-variant/60 rounded-xs">
            <img src="/logo.png" alt="Octipus" className="w-5 h-5 object-contain" />
          </div>
          {!collapsed && (
            <span className="text-sm font-bold text-on-surface whitespace-nowrap">
              octipus
              <span className="text-primary">_</span>
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
      <nav className="flex-1 overflow-y-auto py-3 px-1.5 space-y-3">
        {groups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-2 mb-1 section-label text-[10px]">
                {group.label}
              </div>
            )}
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
          </div>
        ))}
      </nav>

      {/* User identity lives in the header profile dropdown (single source of
          truth); the duplicate sidebar card was removed per QA. */}
    </aside>
  );
}
