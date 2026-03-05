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
    ],
  },
  {
    label: 'System',
    items: [
      { name: 'MCP', href: '/mcp', icon: Cable },
      { name: 'Hooks', href: '/hooks', icon: Webhook },
      { name: 'Tasks', href: '/tasks', icon: Clock },
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
        'flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200/80 dark:border-gray-800 transition-all duration-300 ease-in-out',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-gray-200/80 dark:border-gray-800 shrink-0">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shrink-0 shadow-sm">
            <Bot className="w-4.5 h-4.5 text-white" />
          </div>
          {!collapsed && (
            <span className="text-lg font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">
              Assistant
            </span>
          )}
        </div>
        <button
          onClick={toggle}
          className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer shrink-0"
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
                        : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200'
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
