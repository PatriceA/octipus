'use client';

import {
  BookOpen,
  Bot,
  Brain,
  Cable,
  Cpu,
  FileText,
  FlaskConical,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Users,
  Webhook,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSidebarStore } from '@/lib/sidebar-store';
import { cn } from '@/lib/utils';

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
        'flex flex-col bg-[#000000] border-r border-outline-variant/15 transition-all duration-300 ease-in-out shrink-0 font-body',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <div className="w-8 h-8 bg-gradient-to-br from-primary to-primary-container rounded-sm flex items-center justify-center shrink-0 shadow-[0_0_18px_-4px_rgba(115,255,227,0.5)]">
            <img src="/logo.png" alt="Assistant" className="w-full h-full object-contain" />
          </div>
          {!collapsed && (
            <span className="text-lg font-black tracking-tighter text-primary whitespace-nowrap font-headline">
              Assistant
            </span>
          )}
        </div>
        <button
          onClick={toggle}
          className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-surface-container-low rounded-lg cursor-pointer shrink-0 transition-colors"
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
                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-outline-variant">
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
                      'relative flex items-center gap-4 text-sm font-medium uppercase tracking-[0.08em] transition-all duration-200',
                      collapsed ? 'justify-center px-2 py-2.5 rounded-lg' : 'px-4 py-3',
                      isActive
                        ? 'text-primary bg-gradient-to-r from-primary/10 to-transparent border-r-2 border-primary translate-x-0.5'
                        : 'text-outline-variant hover:text-on-surface-variant hover:bg-surface-container-low border-r-2 border-transparent'
                    )}
                  >
                    <item.icon className={cn('shrink-0', collapsed ? 'w-5 h-5' : 'w-5 h-5')} />
                    {!collapsed && <span>{item.name}</span>}
                  </Link>
                );
              })}
            </div>
            {/* Group spacer — no divider lines per design spec */}
            {group.label !== 'Admin' && !collapsed && (
              <div className="h-3" />
            )}
          </div>
        ))}
      </nav>

      {/* User card at bottom — glass variant */}
      {!collapsed && (
        <div className="px-4 py-4 space-y-3">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-surface-container-lowest border border-outline-variant/20">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-tertiary flex items-center justify-center">
              <Bot className="w-4 h-4 text-on-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-white truncate">System Admin</p>
              <p className="text-[10px] text-on-surface-variant uppercase tracking-widest">Tier-1 Access</p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
