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
  FlaskConical,
  FileText,
  Brain,
  Users,
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
      { name: 'Documents', href: '/documents', icon: FileText },
      { name: 'Profiles', href: '/profiles', icon: Users },
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
      { name: 'Knowledge', href: '/knowledge', icon: Brain },
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
        'flex flex-col bg-[#131313] transition-all duration-300 ease-in-out shrink-0',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <img src="/logo.png" alt="Assistant" className="w-8 h-8 rounded-lg shrink-0 shadow-sm object-cover" />
          {!collapsed && (
            <span className="text-lg font-bold tracking-tighter text-white whitespace-nowrap">
              Assistant
            </span>
          )}
        </div>
        <button
          onClick={toggle}
          className="p-1.5 text-on-surface-variant hover:text-white hover:bg-[#1a1a1a] rounded-lg cursor-pointer shrink-0 transition-colors"
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
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-5">
        {navGroups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-4 mb-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                      'relative flex items-center gap-3 text-sm font-medium transition-all duration-200',
                      collapsed ? 'justify-center px-2 py-2.5 rounded-lg' : 'px-6 py-2.5',
                      isActive
                        ? 'text-white bg-[#1a1a1a] border-l-2 border-primary'
                        : 'text-on-surface-variant hover:text-white hover:bg-[#1a1a1a] border-l-2 border-transparent'
                    )}
                  >
                    <item.icon className={cn('shrink-0', collapsed ? 'w-5 h-5' : 'w-[18px] h-[18px]')} />
                    {!collapsed && <span>{item.name}</span>}
                  </Link>
                );
              })}
            </div>
            {/* Divider between groups */}
            {group.label !== 'Admin' && !collapsed && (
              <div className="h-px bg-outline-variant/10 mt-4 mx-6" />
            )}
          </div>
        ))}
      </nav>

      {/* User card at bottom */}
      {!collapsed && (
        <div className="px-4 py-4 border-t border-outline-variant/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-xs font-bold text-white">System Admin</p>
              <p className="text-[10px] text-on-surface-variant">Superuser Access</p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
