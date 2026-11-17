'use client';

import { useQuery } from '@tanstack/react-query';
import { FieldInputs, type FieldValues, problemsOf } from '@/components/business/common';
import { api } from '@/lib/api';
import type { PluginSetupConfiguration, PluginSetupResources } from '../../../src/shared/plugin-setup';

export function SetupFields({ configuration, values, onChange, secrets, onSecrets, disabled }: {
  configuration: PluginSetupConfiguration; values: FieldValues; onChange: (v: FieldValues) => void;
  secrets: Record<string, string>; onSecrets: (v: Record<string, string>) => void; disabled: boolean;
}) {
  const resources = useQuery({ queryKey: ['plugin-setup-resources'], queryFn: () => api.get<PluginSetupResources>('/plugin-packages/setup/resources'), enabled: configuration.resources.length > 0, retry: false });
  const set = (key: string, value: string) => onChange({ ...values, [key]: value });
  const environments = (resources.data?.environments ?? []).filter(e => !configuration.environmentBackends || configuration.environmentBackends.includes(e.backend));
  const inputClass = 'w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface';
  return <div className="space-y-4" data-testid="plugin-setup-fields">
    <p className="text-sm text-on-surface-variant">Choose existing resources. This does not expand their access. Passwords and tokens are kept in the vault, never in a setup draft.</p>
    {resources.error && <div role="alert" className="text-sm text-error">{problemsOf(resources.error)} <button type="button" onClick={() => resources.refetch()} className="underline">Retry discovery</button></div>}
    {configuration.resources.map(resource => {
      const field = configuration.fields.find(f => f.key === resource.setting);
      if (!field) return null;
      const selected = String(values[field.key] ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean);
      const options = resource.kind === 'environment' ? environments.map(e => ({ value: e.id, label: `${e.name} · ${e.backend}` }))
        : resource.kind === 'folder' ? [...new Set(environments.flatMap(e => e.roots))].map(path => ({ value: path, label: path }))
          : resource.kind === 'connection' ? (resources.data?.connections ?? []).filter(c => resource.connectionKind !== 'git' || c.git).map(c => ({ value: c.id, label: `${c.id} · ${c.origin}` }))
            : [1, 2, 3, 4].map(level => ({ value: String(level), label: `${level} — ${['', 'Standard', 'Internal', 'Confidential', 'Strictly confidential'][level]}${level > configuration.maxProtection ? ' (unsupported by this plugin)' : ''}` }));
      if (resource.kind === 'http-grants') {
        let grants: Record<string, string[]> = {};
        let invalid = false;
        try { const parsed: unknown = JSON.parse(String(values[field.key] || '{}')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(v => !Array.isArray(v) || v.some(p => typeof p !== 'string'))) invalid = true; else grants = parsed as Record<string, string[]>; } catch { invalid = true; }
        return <fieldset key={field.key} disabled={disabled} className="space-y-2 rounded-lg border border-outline-variant p-3"><legend className="px-1 text-sm font-medium">{field.label}</legend>
          <p className="text-xs text-on-surface-variant">Select the connections and exact API paths this plugin may read.</p>
          {invalid && <p role="alert" className="text-sm text-error">The saved access list is invalid. Select its connections and paths again.</p>}
          {(resources.data?.connections ?? []).map(connection => <div key={connection.id} className="space-y-1">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Object.hasOwn(grants, connection.id)} onChange={e => { const next = { ...grants }; if (e.target.checked) next[connection.id] = resource.presets?.[0].paths ?? []; else delete next[connection.id]; set(field.key, JSON.stringify(next)); }} />{connection.id} <span className="text-xs text-on-surface-variant">{connection.origin}</span></label>
            {Object.hasOwn(grants, connection.id) && resource.presets && <label className="block text-xs">Read access for {connection.id}<select aria-label={`Read access for ${connection.id}`} className={inputClass} value={resource.presets.findIndex(p => JSON.stringify(p.paths) === JSON.stringify(grants[connection.id]))} onChange={e => { const preset = resource.presets?.[Number(e.target.value)]; if (preset) set(field.key, JSON.stringify({ ...grants, [connection.id]: preset.paths })); }}><option value="-1">Custom paths</option>{resource.presets.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}</select></label>}
            {Object.hasOwn(grants, connection.id) && <label className="block text-xs">Allowed paths for {connection.id}<textarea aria-label={`Allowed paths for ${connection.id}`} className={inputClass} placeholder={`${connection.pathPrefix} (one exact path per line)`} value={grants[connection.id].join('\n')} onChange={e => set(field.key, JSON.stringify({ ...grants, [connection.id]: e.target.value.split('\n').filter(Boolean) }))} /></label>}
          </div>)}
          <a href="/secrets" className="text-xs text-primary underline">Connect another service in Secrets & Credentials</a>
        </fieldset>;
      }
      return <div key={field.key} className="space-y-1">
        <label htmlFor={`setup-${field.key}`} className="block text-sm font-medium">{field.label}{field.required ? ' *' : ''}</label>
        {resource.multiple ? <div id={`setup-${field.key}`} className="space-y-1 rounded-lg border border-outline-variant p-3">{options.map(option => <label key={option.value} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={selected.includes(option.value)} onChange={e => set(field.key, (e.target.checked ? [...selected, option.value] : selected.filter(v => v !== option.value)).join('\n'))} />{option.label}</label>)}</div>
          : <select id={`setup-${field.key}`} disabled={disabled || resources.isLoading && resource.kind !== 'protection'} className={inputClass} value={String(values[field.key] ?? '')} onChange={e => set(field.key, e.target.value)}><option value="">Choose…</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
        {field.help && <p className="text-xs text-on-surface-variant">{field.help}</p>}
        {resource.kind === 'protection' && <p className="text-xs text-on-surface-variant">Supported up to level {configuration.maxProtection}. If your data requires more protection, keep its classification and use a compatible interface.</p>}
        {!resources.isLoading && options.length === 0 && <a href={resource.kind === 'connection' ? '/secrets' : '/settings?tab=environments'} className="text-xs text-primary underline">No available resources. Configure access first.</a>}
      </div>;
    })}
    <FieldInputs fields={configuration.fields.filter(f => !configuration.resources.some(r => r.setting === f.key))} values={values} onChange={onChange} disabled={disabled} />
    {configuration.secrets.map(secret => <div key={secret.key} className="space-y-1"><label htmlFor={`setup-secret-${secret.key}`} className="block text-sm font-medium">{secret.label}{secret.required && !secret.configured ? ' *' : ''}{secret.configured ? ' · already saved' : ''}</label>
      <input id={`setup-secret-${secret.key}`} className={inputClass} type="password" autoComplete="new-password" disabled={disabled} value={secrets[secret.key] ?? ''} onChange={e => onSecrets({ ...secrets, [secret.key]: e.target.value })} placeholder={secret.configured ? 'Leave empty to keep the saved value' : ''} />
      {secret.help && <p className="text-xs text-on-surface-variant">{secret.help}</p>}
    </div>)}
  </div>;
}
