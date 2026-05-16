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
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Settings className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl text-on-surface">Settings</h1>
          <p className="text-on-surface-variant">System configuration — workspace paths, model routing, channel integrations, security, and notifications.</p>
        </div>
      </div>

      <div className="flex gap-6">
        <div className="w-48 space-y-0.5 shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-[#1a1a1a] hover:text-white'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 bg-[#1a1a1a] rounded-xs p-6">
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
