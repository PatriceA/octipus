'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { ALL_VAULT_KEYS, CHANNEL_KEY_GROUPS, type Credential } from '@/lib/vault-config';
import { useWorkspace } from '@/lib/workspace-context';

const MANAGED_NAMES = new Set(ALL_VAULT_KEYS.map((k) => k.vaultName));

import { OAuthCards } from './oauth-cards';
import { ProviderCards } from './provider-cards';
import { VaultTable } from './vault-table';

export default function SecretsPage() {
  const { activeWorkspace } = useWorkspace();

  const { data, isLoading: loading, refetch } = useQuery({
    queryKey: ['vault', activeWorkspace?.id ?? null],
    queryFn: () => {
      const path = activeWorkspace
        ? `/vault?workspaceId=${encodeURIComponent(activeWorkspace.id)}`
        : '/vault';
      return api.get<{ credentials?: Credential[] }>(path);
    },
  });
  const credentials = data?.credentials ?? [];

  // Derived presence map for the managed vault keys.
  const statuses: Record<string, boolean> = {};
  for (const k of ALL_VAULT_KEYS) {
    statuses[k.vaultName] = credentials.some((c) => c.name === k.vaultName);
  }

  const fetchAll = useCallback(() => { refetch(); }, [refetch]);

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
      <section aria-label="Model provider credentials" className="space-y-3">
        <h2 className="font-semibold">Model providers</h2>
        <ProviderCards statuses={statuses} onStatusChange={fetchAll} />
      </section>

      {/* OAuth Credentials */}
      <details className="rounded-lg border border-outline-variant/20 p-4">
        <summary className="cursor-pointer font-semibold">OAuth integrations</summary>
        <div className="mt-4"><OAuthCards statuses={statuses} onStatusChange={fetchAll} /></div>
      </details>

      {/* Channel bot tokens — stored system-wide via the settings endpoint
          (hot-reloaded). Admin-only; non-admins get "Admin access required". */}
      <section aria-label="Channel credentials" className="space-y-3">
        <h2 className="font-semibold">Chat channels</h2>
        <ProviderCards groups={CHANNEL_KEY_GROUPS} statuses={statuses} onStatusChange={fetchAll} />
      </section>

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
