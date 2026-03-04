'use client';

import { useState } from 'react';
import {
  Settings,
  Bell,
  MessageSquare,
  Plug,
  Shield,
  Sliders,
} from 'lucide-react';
import { GeneralTab } from '@/components/settings/general-tab';
import { ConfigurationTab } from '@/components/settings/configuration-tab';
import { IntegrationsTab } from '@/components/settings/integrations-tab';
import { ChannelsTab } from '@/components/settings/channels-tab';
import { SecurityTab } from '@/components/settings/security-tab';
import { NotificationsTab } from '@/components/settings/notifications-tab';

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general');

  const tabs = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'configuration', label: 'Configuration', icon: Sliders },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'channels', label: 'Channels', icon: MessageSquare },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'notifications', label: 'Notifications', icon: Bell },
  ];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
          <Settings className="w-5 h-5 text-primary-600 dark:text-primary-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Configure your assistant</p>
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
                  ? 'bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-400'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-6">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'configuration' && <ConfigurationTab />}
          {activeTab === 'integrations' && <IntegrationsTab />}
          {activeTab === 'channels' && <ChannelsTab />}
          {activeTab === 'security' && <SecurityTab />}
          {activeTab === 'notifications' && <NotificationsTab />}
        </div>
      </div>
    </div>
  );
}
