'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  MessageSquare,
  Bot,
  Settings,
  Webhook,
  Cpu,
  KeyRound,
  Wrench,
  BookOpen,
  Cable,
  GitBranch,
  PanelLeftClose,
  PanelLeft,
  Clock,
  FlaskConical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSidebarStore } from '@/lib/sidebar-store';

interface NavItem {
  name: string;
  href: string;
  icon: typeof LayoutDashboard;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: 'Main',
    items: [
      { name: 'Dashboard', href: '/', icon: LayoutDashboard },
      { name: 'Chat', href: '/chat', icon: MessageSquare },
    ],
  },
  {
    label: 'AI & Automation',
    items: [
      { name: 'Agents', href: '/agents', icon: Bot },
      { name: 'Models', href: '/models', icon: Cpu },
      { name: 'Pipelines', href: '/pipelines', icon: GitBranch },
      { name: 'Tools', href: '/tools', icon: Wrench },
      { name: 'Skills', href: '/skills', icon: BookOpen },
      { name: 'Evaluations', href: '/eval', icon: FlaskConical },
    ],
  },
  {
    label: 'System',
    items: [
      { name: 'MCP', href: '/mcp', icon: Cable },
      { name: 'Hooks & Tasks', href: '/hooks', icon: Webhook },
    ],
  },
  {
    label: 'Admin',
    items: [
      { name: 'Secrets', href: '/secrets', icon: KeyRound },
      { name: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebarStore();

  return (
    <aside
      className={cn(
        'flex flex-col bg-white dark:bg-[#0E1726] border-r border-primary-100 dark:border-[#1E2D45] transition-all duration-300 ease-in-out',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-primary-100 dark:border-[#1E2D45] shrink-0">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <img src="/logo.png" alt="Assistant" className="w-8 h-8 rounded-lg shrink-0 shadow-sm object-cover" />
          {!collapsed && (
            <span className="text-lg font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">
              Assistant
            </span>
          )}
        </div>
        <button
          onClick={toggle}
          className="p-1.5 text-gray-500 hover:text-primary-600 dark:text-gray-400 dark:hover:text-primary-400 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-950/30 cursor-pointer shrink-0"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeft className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2.5 space-y-5">
        {navGroups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-2 mb-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-500">
                  {group.label}
                </span>
              </div>
            )}
            <div className="space-y-0.5">
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
                      'relative flex items-center gap-2.5 rounded-lg text-sm font-medium transition-all',
                      collapsed ? 'justify-center px-2 py-2.5' : 'px-2.5 py-2',
                      isActive
                        ? 'bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-400'
                        : 'text-gray-600 hover:bg-primary-50 dark:text-gray-400 dark:hover:bg-primary-950/30 hover:text-primary-700 dark:hover:text-primary-300'
                    )}
                  >
                    {isActive && (
                      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary-500 rounded-r-full" />
                    )}
                    <item.icon className={cn('shrink-0', collapsed ? 'w-5 h-5' : 'w-[18px] h-[18px]')} />
                    {!collapsed && <span>{item.name}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
