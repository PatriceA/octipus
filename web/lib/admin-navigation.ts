import { BellRing, Building2, Gauge, MessagesSquare, Network, Puzzle, ScrollText, Users } from 'lucide-react';

export const ADMIN_GROUPS = ['People & access', 'Connections & extensions', 'Usage & oversight'] as const;
export const ADMIN_SECTIONS = [
  { href: '/admin/users', title: 'Users', description: 'Accounts, roles and access to this installation.', group: 'People & access', icon: Users },
  { href: '/admin/orgs', title: 'Organizations', description: 'Organizations, membership and sign-in settings.', group: 'People & access', icon: Building2 },
  { href: '/admin/plugins', title: 'Plugin packages', description: 'Install, review and manage workspace extensions.', group: 'Connections & extensions', icon: Puzzle },
  { href: '/admin/destinations', title: 'Notification destinations', description: 'Where installation notifications are delivered.', group: 'Connections & extensions', icon: BellRing },
  { href: '/admin/group-channels', title: 'Group channels', description: 'Channel enrollments and their owners.', group: 'Connections & extensions', icon: MessagesSquare },
  { href: '/admin/federation', title: 'Federation', description: 'Trust and connections with other Octipus installations.', group: 'Connections & extensions', icon: Network },
  { href: '/admin/quotas', title: 'Quotas & budgets', description: 'Resource limits and spending controls.', group: 'Usage & oversight', icon: Gauge },
  { href: '/admin/audit', title: 'Audit log', description: 'Review recorded administrative actions.', group: 'Usage & oversight', icon: ScrollText },
] as const;
