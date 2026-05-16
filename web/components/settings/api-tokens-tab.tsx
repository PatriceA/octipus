'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Key, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Personal access tokens — Phase 2b multi-user.
 *
 * UI for the `/api/auth/api-tokens` REST surface that landed in Phase
 * 2a. Three things happen here:
 *
 *   1. List existing tokens (server returns name + prefix + dates,
 *      never the plaintext or the hash).
 *   2. Generate a new token. The server returns the plaintext exactly
 *      once on POST — we surface it in a one-time copy modal that the
 *      user must dismiss. After dismissal the plaintext is gone from
 *      memory.
 *   3. Revoke a token (with confirm guard so a misclick doesn't break
 *      a CI integration).
 *
 * The plaintext modal is the load-bearing UX bit: the only chance the
 * user has to capture the token. It needs a copy button, a clear
 * "you won't see this again" warning, and a deliberate dismiss action
 * (no implicit close-on-outside-click).
 */

interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface IssuedToken extends TokenSummary {
  token: string;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 30 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function ApiTokensTab() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['api-tokens'],
    queryFn: () => api.get<{ tokens: TokenSummary[] }>('/auth/api-tokens'),
  });

  const issueMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name: name.trim() };
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      return api.post<IssuedToken>('/auth/api-tokens', body);
    },
    onSuccess: (data) => {
      setIssued(data);
      setName('');
      setExpiresAt('');
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (err: Error) => setError(err.message || 'Failed to issue token'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ revoked: boolean }>(`/auth/api-tokens/${id}`),
    onSuccess: () => {
      setConfirmRevokeId(null);
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (err: Error) => setError(err.message || 'Failed to revoke token'),
  });

  // Reset the "Copied!" badge after a short delay.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
    } catch {
      // navigator.clipboard fails on http:// or older browsers; fall
      // back to a manual select + copy via a hidden textarea.
      const ta = document.createElement('textarea');
      ta.value = issued.token;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); setCopied(true); } catch { /* nothing else we can do */ }
      document.body.removeChild(ta);
    }
  };

  const tokens = data?.tokens ?? [];
  const active = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-extrabold tracking-tighter text-on-surface">API Tokens</h2>
          <p className="text-sm text-on-surface-variant mt-1">
            Personal access tokens for non-browser clients (CI, MCP servers, scripts, the
            browser extension). Send as <code className="px-1 py-0.5 bg-surface-container-high rounded text-xs">Authorization: Bearer octi_…</code>.
          </p>
        </div>
      </div>

      {/* Create form */}
      <div className="p-4 bg-surface-container-low rounded-lg space-y-3">
        <h3 className="font-medium text-on-surface text-sm">Generate a new token</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 100))}
            placeholder="Token name (e.g. CI deploy bot)"
            className="md:col-span-2 bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
          />
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            placeholder="Expires (optional)"
            className="bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => issueMutation.mutate()}
            disabled={!name.trim() || issueMutation.isPending}
            className="px-4 py-2 bg-primary text-[#0e0e0e] rounded-lg text-sm font-medium hover:bg-primary-container disabled:opacity-50 cursor-pointer"
          >
            {issueMutation.isPending ? 'Generating…' : 'Generate token'}
          </button>
          <p className="text-xs text-on-surface-variant">
            Empty expiry = never expires. Plaintext is shown only once.
          </p>
        </div>
        {error && (
          <div className="p-2 bg-error-dim/10 border border-error-dim/20 rounded text-sm text-error">{error}</div>
        )}
      </div>

      {/* Active tokens */}
      <div className="space-y-2">
        <h3 className="font-medium text-on-surface text-sm flex items-center gap-2">
          <Key className="w-4 h-4" /> Active tokens
          <span className="text-on-surface-variant font-normal">({active.length})</span>
        </h3>
        {isLoading && <p className="text-sm text-on-surface-variant">Loading…</p>}
        {!isLoading && active.length === 0 && (
          <p className="text-sm text-on-surface-variant p-4 bg-surface-container-low rounded-lg">
            No active tokens. Generate one above to authenticate non-browser clients.
          </p>
        )}
        {active.map((t) => (
          <div key={t.id} className="flex items-center justify-between p-3 bg-surface-container-low rounded-lg">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-on-surface truncate">{t.name}</span>
                <code className="text-xs text-on-surface-variant font-mono">{t.prefix}…</code>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant mt-1">
                <span>Created {formatRelative(t.createdAt)}</span>
                <span>Last used {formatRelative(t.lastUsedAt)}</span>
                {t.expiresAt && <span>Expires {formatAbsolute(t.expiresAt)}</span>}
                {!t.expiresAt && <span>Never expires</span>}
              </div>
            </div>
            {confirmRevokeId === t.id ? (
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <span className="text-xs text-on-surface-variant">Revoke?</span>
                <button
                  type="button"
                  onClick={() => revokeMutation.mutate(t.id)}
                  disabled={revokeMutation.isPending}
                  className="px-3 py-1.5 text-xs bg-red-600 text-on-surface rounded-lg hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRevokeId(null)}
                  className="px-3 py-1.5 text-xs bg-surface-container-high text-on-surface-variant rounded-lg hover:text-on-surface cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setConfirmRevokeId(t.id); setError(null); }}
                className="ml-3 shrink-0 p-2 rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-red-400 cursor-pointer"
                aria-label={`Revoke ${t.name}`}
                title="Revoke"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Revoked tokens (collapsed-ish, just listed for audit) */}
      {revoked.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-on-surface-variant text-sm">
            Revoked ({revoked.length})
          </h3>
          {revoked.map((t) => (
            <div key={t.id} className="flex items-center justify-between p-3 bg-surface-container-low rounded-lg opacity-60">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-on-surface-variant line-through truncate">{t.name}</span>
                  <code className="text-xs text-on-surface-variant font-mono">{t.prefix}…</code>
                </div>
                <p className="text-xs text-on-surface-variant mt-1">
                  Revoked {formatRelative(t.revokedAt)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* One-time plaintext modal — load-bearing UX. */}
      {issued && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-surface-container rounded-2xl p-6 max-w-lg w-full space-y-4 border border-primary/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-extrabold tracking-tighter text-on-surface">Token created</h3>
                <p className="text-sm text-on-surface-variant mt-1">
                  Copy it now — <strong className="text-on-surface">it will never be shown again</strong>.
                  Store it in your secret manager (1Password, GitHub Actions secrets, etc.).
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setIssued(null); setCopied(false); }}
                className="p-1 rounded text-on-surface-variant hover:text-on-surface cursor-pointer"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-on-surface-variant uppercase tracking-wide font-bold">{issued.name}</p>
              <div className="flex items-stretch gap-2">
                <code className="flex-1 px-3 py-3 bg-background rounded font-mono text-sm break-all text-on-surface select-all">
                  {issued.token}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className={`px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 cursor-pointer ${
                    copied
                      ? 'bg-green-600 text-on-surface'
                      : 'bg-primary text-[#0e0e0e] hover:bg-primary-container'
                  }`}
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => { setIssued(null); setCopied(false); }}
                className="px-4 py-2 bg-surface-container-high text-on-surface rounded-lg hover:bg-[#333] text-sm cursor-pointer"
              >
                I've saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
