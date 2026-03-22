'use client';

import { useState, useEffect, useCallback } from 'react';
import { KeyRound } from 'lucide-react';
import { api } from '@/lib/api';
import { ALL_VAULT_KEYS, type Credential } from '@/lib/vault-config';

const MANAGED_NAMES = new Set(ALL_VAULT_KEYS.map((k) => k.vaultName));
import { ProviderCards } from './provider-cards';
import { OAuthCards } from './oauth-cards';
import { VaultTable } from './vault-table';

export default function SecretsPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const data = await api.get<{ credentials?: Credential[] }>('/vault');
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
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[#1a1a1a] rounded-lg w-48" />
          <div className="h-40 bg-[#1a1a1a] rounded-xl" />
          <div className="h-40 bg-[#1a1a1a] rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <KeyRound className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-4xl font-extrabold tracking-tighter text-white">
            Secrets & Credentials
          </h1>
          <p className="text-sm text-on-surface-variant">
            Manage API keys, OAuth credentials, and other secrets in one place.
          </p>
        </div>
      </div>

      {/* Provider Quick Setup */}
      <ProviderCards statuses={statuses} onStatusChange={fetchAll} />

      {/* OAuth Credentials */}
      <OAuthCards statuses={statuses} onStatusChange={fetchAll} />

      {/* Divider */}
      <hr className="border-outline-variant/10" />

      {/* All Vault Entries */}
      <VaultTable credentials={credentials.filter((c) => !MANAGED_NAMES.has(c.name))} onRefresh={fetchAll} />
    </div>
  );
}
