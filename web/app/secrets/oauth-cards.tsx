'use client';

import { AlertCircle, CheckCircle, ChevronDown, ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { OAUTH_KEY_GROUPS } from '@/lib/vault-config';

interface OAuthCardsProps {
  statuses: Record<string, boolean>;
  onStatusChange: () => void;
}

const SETUP_GUIDES: Record<string, { url: string; steps: string[] }> = {
  'Google OAuth Credentials': {
    url: 'https://console.cloud.google.com/apis/credentials',
    steps: [
      'Go to Google Cloud Console > APIs & Credentials',
      'Create an OAuth 2.0 Client ID (Web application)',
      'Add your redirect URI: http://YOUR_HOST:3005/api/auth/oauth/google/callback',
      'Copy the Client ID and Client Secret here',
    ],
  },
  'Microsoft OAuth Credentials': {
    url: 'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps',
    steps: [
      'Go to Azure Portal > App registrations',
      'Register a new application',
      'Add redirect URI: http://YOUR_HOST:3005/api/auth/oauth/microsoft/callback',
      'Create a client secret under Certificates & secrets',
      'Copy the Application (Client) ID, Client Secret, and Tenant ID here',
    ],
  },
};

export function OAuthCards({ statuses, onStatusChange }: OAuthCardsProps) {
  return (
    <div>
      <h2 className="text-base font-extrabold tracking-tighter text-on-surface mb-1">
        OAuth Credentials
      </h2>
      <p className="text-sm text-on-surface-variant mb-4">
        Configure OAuth client credentials for third-party integrations.
      </p>
      <div className="space-y-3">
        {OAUTH_KEY_GROUPS.map((group) => (
          <OAuthGroupCard
            key={group.title}
            group={group}
            statuses={statuses}
            onStatusChange={onStatusChange}
          />
        ))}
      </div>
    </div>
  );
}

function OAuthGroupCard({
  group,
  statuses,
  onStatusChange,
}: {
  group: typeof OAUTH_KEY_GROUPS[0];
  statuses: Record<string, boolean>;
  onStatusChange: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const guide = SETUP_GUIDES[group.title];
  const allSaved = group.keys.every((k) => statuses[k.vaultName]);

  useEffect(() => {
    if (feedback) {
      const t = setTimeout(() => setFeedback(null), 5000);
      return () => clearTimeout(t);
    }
  }, [feedback]);

  const handleSaveAll = async () => {
    const entries = group.keys.filter((k) => values[k.vaultName]);
    if (entries.length === 0) return;
    setSaving(true);
    try {
      for (const k of entries) {
        await api.post('/vault', {
          name: k.vaultName,
          value: values[k.vaultName],
          credentialType: 'api_key',
          description: `${group.title}: ${k.label}`,
          tags: ['oauth', 'provider'],
          systemLevel: true,
        });
      }
      setValues({});
      onStatusChange();
      setFeedback({ type: 'success', message: `${entries.length} credential(s) saved` });
    } catch (err) {
      setFeedback({ type: 'error', message: `Failed: ${(err as Error).message}` });
    }
    setSaving(false);
  };

  return (
    <div className="p-4 bg-surface-container rounded-xs">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-on-surface">{group.title}</span>
          <span
            className={`w-2 h-2 rounded-full ${allSaved ? 'bg-tertiary' : 'bg-[#484847]'}`}
            title={allSaved ? 'All configured' : 'Setup required'}
          />
        </div>
      </div>
      <p className="text-xs text-on-surface-variant mb-3">{group.description}</p>

      <div className="space-y-2">
        {group.keys.map((k) => (
          <div key={k.vaultName} className="flex items-center gap-2">
            <label className="w-24 text-xs font-bold text-on-surface-variant uppercase shrink-0">
              {k.label}
            </label>
            <input
              type="password"
              value={values[k.vaultName] || ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [k.vaultName]: e.target.value }))}
              placeholder={statuses[k.vaultName] ? 'Saved (enter new to replace)' : k.placeholder || 'Enter value...'}
              className="flex-1 bg-surface-container-high border-none rounded-md py-3 px-4 text-on-surface text-sm placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mt-3">
        <div className="flex items-center gap-3">
          <button
            onClick={handleSaveAll}
            disabled={saving || group.keys.every((k) => !values[k.vaultName])}
            className="px-3 py-1.5 text-xs font-medium bg-primary text-[#0e0e0e] rounded-lg hover:bg-primary-container disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 cursor-pointer"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Save
          </button>

          {feedback && (
            <span className={`flex items-center gap-1 text-xs ${
              feedback.type === 'success' ? 'text-tertiary' : 'text-error'
            }`}>
              {feedback.type === 'success'
                ? <CheckCircle className="w-3 h-3" />
                : <AlertCircle className="w-3 h-3" />
              }
              {feedback.message}
            </span>
          )}
        </div>

        {guide && (
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-primary cursor-pointer"
          >
            Setup guide
            <ChevronDown className={`w-3 h-3 transition-transform ${showGuide ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {showGuide && guide && (
        <div className="mt-3 p-3 bg-surface-container-low rounded-lg text-xs text-on-surface-variant space-y-1.5">
          <ol className="list-decimal list-inside space-y-1">
            {guide.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <a
            href={guide.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline mt-1"
          >
            Open developer console <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}
    </div>
  );
}
