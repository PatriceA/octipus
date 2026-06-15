'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { ALL_VAULT_KEYS, CHANNEL_KEY_GROUPS, type Credential } from '@/lib/vault-config';
import { useWorkspace } from '@/lib/workspace-context';

const MANAGED_NAMES = new Set(ALL_VAULT_KEYS.map((k) => k.vaultName));

import { OAuthCards } from './oauth-cards';
import { ProviderCards } from './provider-cards';
import { VaultTable } from './vault-table';

export default function SecretsPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const { activeWorkspace } = useWorkspace();

  const fetchAll = useCallback(async () => {
    try {
      const path = activeWorkspace
        ? `/vault?workspaceId=${encodeURIComponent(activeWorkspace.id)}`
        : '/vault';
      const data = await api.get<{ credentials?: Credential[] }>(path);
      const creds = data?.credentials ?? [];
      setCredentials(creds);

      const s: Record<string, boolean> = {};
      for (const k of ALL_VAULT_KEYS) {
        s[k.vaultName] = creds.some((c) => c.name === k.vaultName);
      }
      setStatuses(s);
    } catch (error) {
      console.error('Failed to fetch credentials:', error);
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-surface-container rounded-lg w-48" />
          <div className="h-40 bg-surface-container rounded-xl" />
          <div className="h-40 bg-surface-container rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl font-mono">
      {/* Page header */}
      <PageHeader
        title="secrets"
        description="manage API keys and provider credentials. all secrets are stored with AES-256-GCM encryption."
      />

      {/* Provider Quick Setup */}
      <ProviderCards statuses={statuses} onStatusChange={fetchAll} />

      {/* OAuth Credentials */}
      <OAuthCards statuses={statuses} onStatusChange={fetchAll} />

      {/* Channel bot tokens — stored system-wide via the settings endpoint
          (hot-reloaded). Admin-only; non-admins get "Admin access required". */}
      <ProviderCards groups={CHANNEL_KEY_GROUPS} statuses={statuses} onStatusChange={fetchAll} />

      {/* Divider */}
      <hr className="border-outline-variant/10" />

      {/* All Vault Entries */}
      <VaultTable
        credentials={credentials.filter((c) => !MANAGED_NAMES.has(c.name))}
        onRefresh={fetchAll}
        workspaceId={activeWorkspace?.id ?? null}
        workspaceName={activeWorkspace?.name ?? null}
      />
    </div>
  );
}
