'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface NotificationSetting {
  key: string;
  label: string;
  description: string;
}

const NOTIFICATION_SETTINGS: NotificationSetting[] = [
  { key: 'notifications.agentCompletion', label: 'Agent completion notifications', description: 'Get notified when an agent finishes its task' },
  { key: 'notifications.permissionRequest', label: 'Permission request notifications', description: 'Get notified when an agent needs your permission' },
  { key: 'notifications.pipelineApproval', label: 'Pipeline approval notifications', description: 'Get notified when a pipeline stage awaits approval' },
  { key: 'notifications.errors', label: 'Error notifications', description: 'Get notified on agent or pipeline errors' },
];

export function NotificationsTab() {
  const [values, setValues] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ settings?: Record<string, Array<{ key: string; value: unknown }>>; error?: string }>('/settings')
      .then(data => {
        if (!data.settings) throw new Error(data.error || 'Could not load notification settings.');
        const notifications = data.settings.notifications || [];
        const vals: Record<string, boolean> = {};
        for (const s of notifications) {
          vals[s.key] = s.value === true || s.value === 'true';
        }
        // Apply defaults for missing settings
        for (const ns of NOTIFICATION_SETTINGS) {
          if (!(ns.key in vals)) {
            vals[ns.key] = ns.key !== 'notifications.errors'; // errors default to false
          }
        }
        setValues(vals);
      })
      .catch(error => setLoadError(error instanceof Error ? error.message : 'Could not load notification settings.'))
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = async (key: string) => {
    const newValue = !values[key];
    setSaveError(null);
    setValues(prev => ({ ...prev, [key]: newValue }));
    setSaving(key);
    try {
      const result = await api.put<{ success?: boolean; error?: string }>(`/settings/${encodeURIComponent(key)}`, { value: newValue });
      if (!result.success) throw new Error(result.error || 'Could not save notification settings.');
    } catch (error) {
      // Revert on error
      setValues(prev => ({ ...prev, [key]: !newValue }));
      setSaveError(error instanceof Error ? error.message : 'Could not save notification settings.');
    }
    setSaving(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-on-surface-variant">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-extrabold tracking-tighter text-on-surface">Notifications</h2>
      {(loadError || saveError) && <p role="alert" className="text-sm text-error">{loadError || saveError}</p>}

      <div className="space-y-4">
        {NOTIFICATION_SETTINGS.map(ns => (
          <label key={ns.key} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values[ns.key] ?? false}
              onChange={() => handleToggle(ns.key)}
              disabled={saving !== null || loadError !== null}
              className="w-4 h-4 rounded accent-primary mt-0.5"
            />
            <div>
              <span className="text-on-surface">{ns.label}</span>
              <p className="text-xs text-on-surface-variant mt-0.5">{ns.description}</p>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
