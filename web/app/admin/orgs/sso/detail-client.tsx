'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Save, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';

interface SsoConfig {
  orgId: string;
  samlEnabled: boolean;
  samlEntityId: string | null;
  samlSsoUrl: string | null;
  samlX509Cert: string | null;
  samlAttributeMap: Record<string, string>;
  scimEnabled: boolean;
  scimTokenVaultRef: string | null;
}

const DEFAULT_ATTRS: Record<string, string> = {
  username: 'username',
  email: 'email',
};

export default function OrgSsoPage() {
  const id = useSearchParams().get('id') ?? '';
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SsoConfig | null>(null);
  const [seededFrom, setSeededFrom] = useState<SsoConfig | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'orgs', id, 'sso'],
    queryFn: () => api.get<SsoConfig>(`/admin/orgs/${id}/sso`),
  });

  // Seed the editable draft from freshly-loaded data — adjusting state during
  // render (the React-endorsed pattern) instead of in an effect.
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setDraft(data);
  }

  const saveMutation = useMutation({
    mutationFn: (body: SsoConfig) => api.patch<SsoConfig>(`/admin/orgs/${id}/sso`, {
      samlEnabled: body.samlEnabled,
      samlEntityId: body.samlEntityId ?? undefined,
      samlSsoUrl: body.samlSsoUrl ?? undefined,
      samlX509Cert: body.samlX509Cert ?? undefined,
      samlAttributeMap: body.samlAttributeMap,
      scimEnabled: body.scimEnabled,
      scimTokenVaultRef: body.scimTokenVaultRef ?? undefined,
    }),
    onSuccess: (next) => {
      setDraft(next);
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 1800);
      queryClient.invalidateQueries({ queryKey: ['admin', 'orgs', id, 'sso'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (isLoading || !draft) return <div className="p-8 text-on-surface-variant">Loading…</div>;

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const metadataUrl = `${baseUrl}/api/saml/<orgSlug>/metadata`;
  const acsUrl = `${baseUrl}/api/saml/<orgSlug>/acs`;

  const update = (patch: Partial<SsoConfig>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const setAttr = (key: string, value: string) => {
    const next = { ...draft.samlAttributeMap };
    if (value) next[key] = value;
    else delete next[key];
    update({ samlAttributeMap: next });
  };

  const attrs = { ...DEFAULT_ATTRS, ...draft.samlAttributeMap };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link href="/admin/orgs" className="text-on-surface-variant hover:text-on-surface">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <h2 className="section-label">sso + scim</h2>
        {savedToast && <span className="text-xs text-tertiary">saved ✓</span>}
      </div>

      {/* SAML */}
      <section className="term-frame rounded-xs p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-on-surface-variant" />
          <h3 className="text-[13px] text-on-surface"><span aria-hidden className="text-primary font-bold">&gt; </span>SAML 2.0</h3>
          <label className="ml-auto flex items-center gap-2 text-sm text-on-surface-variant">
            <input
              type="checkbox"
              checked={draft.samlEnabled}
              onChange={(e) => update({ samlEnabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>

        <p className="text-xs text-on-surface-variant leading-relaxed">
          <strong className="text-on-surface">What this is:</strong> SAML lets users in this org sign in
          through your existing identity provider (Okta, Azure AD, Google Workspace, …) instead of
          managing a separate Octipus password. Users land on the IdP&apos;s login page, get
          redirected back to Octipus already authenticated. Use this if your company already has
          SSO — it removes one more credential to manage and lets you offboard users centrally.
          Leave disabled if you only have a handful of users.
        </p>

        <div className="text-xs text-on-surface-variant space-y-1">
          <p>SP metadata URL — give this to the IdP:</p>
          <code className="block px-2 py-1 bg-background rounded text-on-surface">{metadataUrl}</code>
          <p className="mt-2">ACS URL:</p>
          <code className="block px-2 py-1 bg-background rounded text-on-surface">{acsUrl}</code>
        </div>

        <Field
          label="IdP Entity ID"
          value={draft.samlEntityId ?? ''}
          onChange={(v) => update({ samlEntityId: v })}
          placeholder="https://idp.example.com/saml"
        />
        <Field
          label="IdP SSO URL"
          value={draft.samlSsoUrl ?? ''}
          onChange={(v) => update({ samlSsoUrl: v })}
          placeholder="https://idp.example.com/sso/saml"
        />
        <Field
          label="IdP x509 certificate (PEM)"
          value={draft.samlX509Cert ?? ''}
          onChange={(v) => update({ samlX509Cert: v })}
          placeholder="-----BEGIN CERTIFICATE-----..."
          textarea
        />

        <div className="space-y-2">
          <label className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
            Attribute mapping
          </label>
          <p className="text-xs text-on-surface-variant">
            Match SAML attribute names to Octipus user fields. Defaults match Okta &amp; Azure AD.
          </p>
          <Field label="Username attribute" value={attrs.username} onChange={(v) => setAttr('username', v)} placeholder="username" />
          <Field label="Email attribute" value={attrs.email} onChange={(v) => setAttr('email', v)} placeholder="email" />
        </div>
      </section>

      {/* SCIM */}
      <section className="term-frame rounded-xs p-5 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-on-surface-variant" />
          <h3 className="text-[13px] text-on-surface"><span aria-hidden className="text-primary font-bold">&gt; </span>SCIM 2.0 inbound provisioning</h3>
          <label className="ml-auto flex items-center gap-2 text-sm text-on-surface-variant">
            <input
              type="checkbox"
              checked={draft.scimEnabled}
              onChange={(e) => update({ scimEnabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>

        <p className="text-xs text-on-surface-variant leading-relaxed">
          <strong className="text-on-surface">What this is:</strong> SCIM lets your IdP push user
          create/update/delete events into Octipus automatically — so when HR adds someone in Okta
          or Azure AD, they appear here within minutes (and disappear when removed). Pair it with
          SAML above to fully outsource user lifecycle. Without SCIM you&apos;d add and remove people
          here by hand. Configure the bearer token on the IdP side and store its value in the
          system vault, then reference it by name below.
        </p>

        <div className="text-xs text-on-surface-variant">
          <p>SCIM endpoint:</p>
          <code className="block px-2 py-1 bg-background rounded text-on-surface mt-1">{baseUrl}/api/scim/v2</code>
          <p className="mt-2">
            Bearer token is stored in the system vault under the name below. Add the secret first
            via <code>POST /api/vault</code> with <code>systemLevel: true</code>, then paste the
            vault entry name here.
          </p>
        </div>

        <Field
          label="Vault entry name (the SCIM bearer)"
          value={draft.scimTokenVaultRef ?? ''}
          onChange={(v) => update({ scimTokenVaultRef: v })}
          placeholder="scim_token_acme"
        />
      </section>

      {error && <p className="text-xs text-error">! {error}</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => { setError(null); saveMutation.mutate(draft); }}
          disabled={saveMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-xs text-sm font-medium hover:bg-primary-dim disabled:opacity-50 cursor-pointer"
        >
          <Save className="w-4 h-4" />
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  textarea?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
        {label}
      </label>
      {textarea ? (
        <textarea
          rows={6}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 bg-background border border-outline-variant/20 rounded-lg text-sm text-on-surface font-mono placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 bg-background border border-outline-variant/20 rounded-lg text-sm text-on-surface placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
        />
      )}
    </div>
  );
}
