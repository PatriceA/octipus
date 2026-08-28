'use client';

import {
  Bell,
  Key,
  MessageSquare,
  Phone,
  Plug,
  Settings,
  Shield,
  Sliders,
  Smartphone,
} from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { ApiTokensTab } from '@/components/settings/api-tokens-tab';
import { ChannelsTab } from '@/components/settings/channels-tab';
import { ConfigurationTab } from '@/components/settings/configuration-tab';
import { GeneralTab } from '@/components/settings/general-tab';
import { IntegrationsTab } from '@/components/settings/integrations-tab';
import { MobileTab } from '@/components/settings/mobile-tab';
import { NotificationsTab } from '@/components/settings/notifications-tab';
import { SecurityTab } from '@/components/settings/security-tab';
import { VoiceTab } from '@/components/settings/voice-tab';

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general');

  const tabs = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'configuration', label: 'Configuration', icon: Sliders },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'channels', label: 'Channels', icon: MessageSquare },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'api-tokens', label: 'API Tokens', icon: Key },
    { id: 'voice', label: 'Voice & Calls', icon: Phone },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'mobile', label: 'Mobile App', icon: Smartphone },
  ];

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        title="settings"
        description="system configuration — workspace paths, model routing, channel integrations, security, and notifications."
      />

      {/* Rail + panel. The rail keeps its own border so the two columns read as
          separate surfaces; without it the tab list floated in the page and the
          panel had no edge to sit against. */}
      <div className="flex flex-col md:flex-row gap-4 md:gap-6 items-stretch">
        <nav
          aria-label="Settings sections"
          className="md:w-52 shrink-0 flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible md:border-r md:border-outline-variant md:pr-4"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-primary ${
                activeTab === tab.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
              }`}
            >
              <tab.icon className="w-4 h-4 shrink-0" />
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-w-0 bg-surface-container border border-outline-variant rounded-md p-6">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'configuration' && <ConfigurationTab />}
          {activeTab === 'integrations' && <IntegrationsTab />}
          {activeTab === 'channels' && <ChannelsTab />}
          {activeTab === 'security' && <SecurityTab />}
          {activeTab === 'api-tokens' && <ApiTokensTab />}
          {activeTab === 'voice' && <VoiceTab />}
          {activeTab === 'notifications' && <NotificationsTab />}
          {activeTab === 'mobile' && <MobileTab />}
        </div>
      </div>
    </div>
  );
}
