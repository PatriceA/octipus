'use client';
import { ArrowLeft, ArrowRight, Cpu, Link2, Search, Settings, Shield, Sparkles, User } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useModules, usePageOn } from '@/lib/modules';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/ui/page-header';
import { ApiTokensTab } from '@/components/settings/api-tokens-tab';
import { EnvironmentsTab } from '@/components/settings/environments-tab';
import { CliToolsTab } from '@/components/settings/cli-tools-tab';
import { ChannelsTab } from '@/components/settings/channels-tab';
import { ConfigurationTab } from '@/components/settings/configuration-tab';
import { AppearanceTab } from '@/components/settings/appearance-tab';
import { GeneralTab } from '@/components/settings/general-tab';
import { HeartbeatTab } from '@/components/settings/heartbeat-tab';
import { IntegrationsTab } from '@/components/settings/integrations-tab';
import { MobileTab } from '@/components/settings/mobile-tab';
import { MailboxManager } from '@/components/mail/mailbox-manager';
import { ModulesTab } from '@/components/settings/modules-tab';
import { MyModelsTab } from '@/components/settings/my-models-tab';
import { NotificationsTab } from '@/components/settings/notifications-tab';
import { RemoteSpacesTab } from '@/components/settings/remote-spaces-tab';
import { SecurityTab } from '@/components/settings/security-tab';
import { VoiceTab } from '@/components/settings/voice-tab';
import { PluginUsageTab } from '@/components/settings/plugin-usage-tab';
import { settingsGroups } from '@/components/settings/settings-map';
import { BudgetsCard } from '@/components/dashboard/budgets-card';
import { UsageSummary } from '@/components/dashboard/usage-summary';
import { UsageChart } from '@/components/dashboard/usage-chart';
import { FeatureStatus } from '@/components/dashboard/feature-status';

const icons = { user: User, spark: Sparkles, cpu: Cpu, connect: Link2, shield: Shield, settings: Settings };
export default function SettingsPage() {
  const tab = useSearchParams().get('tab');
  const router = useRouter();
  const { user } = useAuth();
  const modules = useModules();
  const pageOn = usePageOn();
  const [search, setSearch] = useState('');
  const permitted = settingsGroups.map(group => ({ ...group, entries: group.entries.filter(entry => (!entry.admin || user?.isAdmin) && (!entry.module || modules.data?.enabled.includes(entry.module)) && (!entry.href || pageOn(entry.href))) }));
  const entry = permitted.flatMap(group => group.entries).find(item => item.tab === tab);
  const group = permitted.find(group => group.entries.includes(entry!));
  const terms = search.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const groups = permitted.map(group => ({ ...group, entries: group.entries.filter(entry => { const words = `${group.name} ${entry.title} ${entry.keywords}`.toLowerCase().split(/[^a-z0-9]+/); return terms.every(term => words.some(word => word.startsWith(term))); }) })).filter(group => group.entries.length);
  const panels: Record<string, React.ReactNode> = {
    appearance: <AppearanceTab />, general: <GeneralTab />, modules: <ModulesTab />, configuration: <ConfigurationTab />, environments: <EnvironmentsTab />,
    integrations: <IntegrationsTab />, folders: <IntegrationsTab foldersOnly />, 'cli-tools': <CliToolsTab />,
    mailboxes: <MailboxManager />, channels: <ChannelsTab />, security: <SecurityTab />, 'api-tokens': <ApiTokensTab />,
    'my-models': <MyModelsTab />, 'remote-spaces': <RemoteSpacesTab />, voice: <VoiceTab />, notifications: <NotificationsTab />,
    heartbeat: <HeartbeatTab />, mobile: <MobileTab />, 'plugin-usage': <PluginUsageTab />, usage: <div className="space-y-5"><UsageSummary /><BudgetsCard /><UsageChart /></div>,
    health: <div className="space-y-5"><GeneralTab section="health" /><FeatureStatus /></div>,
  };
  return <div className="settings-workspace">
    <PageHeader title="Settings" description={tab ? group?.name : 'Your workspace, your companion, and the access behind the work.'} />
    {tab ? <><nav className="settings-breadcrumb" aria-label="Settings location"><button onClick={() => { setSearch(''); router.push('/settings'); }}><ArrowLeft size={14} />All settings</button><span>/</span><span>{entry?.title ?? (tab === 'cli-tools' ? 'CLI tools' : 'Unavailable section')}</span></nav>
      <div className="settings-detail" key={tab}>{entry || tab === 'cli-tools' ? panels[tab] : <p>This section is unavailable or you do not have access. <Link href="/settings">Browse available settings.</Link></p>}</div></>
      : <><label className="settings-search"><Search size={18} aria-hidden /><span className="sr-only">Find a setting</span><input type="search" placeholder="Find a setting — heartbeat, email, gh…" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="settings-groups">{groups.map(group => { const Icon = icons[group.icon as keyof typeof icons]; return <section key={group.name} className="settings-group"><Icon size={20} aria-hidden /><h2>{group.name}</h2><p>{group.description}</p>{group.entries.map(item => item.tab ? <button key={item.title} onClick={() => router.push(`/settings?tab=${item.tab}`)}>{item.title}<ArrowRight size={13} aria-hidden /></button> : <Link key={item.title} href={item.href!}>{item.title}<ArrowRight size={13} aria-hidden /></Link>)}</section>; })}</div>{!groups.length && <p className="desk-empty">No settings match. Try “access”, “models”, or “notifications”.</p>}</>}
  </div>;
}
