'use client';
import { providerControls, type ModelPricing, type ProviderSettings } from '../../../src/shared/provider-settings';

export function ProviderSettingsFields({ provider, model, settings, pricing, controls: serverControls, onSettings, onPricing }: {
  provider: string; model: string; controls?: ReturnType<typeof providerControls>; settings: ProviderSettings; pricing: ModelPricing;
  onSettings: (s: ProviderSettings) => void; onPricing: (p: ModelPricing) => void;
}) {
  const controls = serverControls ?? providerControls(provider, model);
  const inputClass = 'w-full rounded-lg bg-surface-container-high px-3 py-2 text-on-surface border border-outline-variant/10';
  return <fieldset className="space-y-3 border-t border-outline-variant/10 pt-4">
    <legend className="text-sm font-medium text-on-surface">Provider controls and pricing</legend>
    <p className="text-xs text-on-surface-variant">Availability depends on the selected model. Default leaves the provider setting unchanged. Provider charges take precedence over estimates.</p>
    {controls.reasoning && <label className="block text-sm">Reasoning effort
      <select className={inputClass} value={settings.reasoningEffort ?? ''} onChange={e => onSettings({ ...settings, reasoningEffort: (e.target.value || undefined) as ProviderSettings['reasoningEffort'] })}>
        <option value="">Provider default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
      </select>
    </label>}
    {controls.thinkingBudget && <label className="block text-sm">Manual thinking budget (tokens; below output limit)
      <input className={inputClass} type="number" min={1024} step={1} value={settings.thinkingBudget ?? ''} onChange={e => onSettings({ ...settings, thinkingBudget: e.target.value === '' ? undefined : Number(e.target.value) })} />
    </label>}
    {controls.cachePolicy && <label className="block text-sm">Prompt cache policy
      <select className={inputClass} value={settings.cachePolicy ?? 'default'} onChange={e => onSettings({ ...settings, cachePolicy: e.target.value as ProviderSettings['cachePolicy'] })}>
        <option value="default">Provider default</option><option value="session">Session affinity / stable prefix</option><option value="off">Disable Octipus cache hints</option>
      </select><span className="text-xs text-on-surface-variant">Upstream automatic caching may still apply.</span>
    </label>}
    {controls.cachedContent && <label className="block text-sm">Existing Gemini cache reference
      <input className={inputClass} placeholder="cachedContents/…" value={settings.cachedContent ?? ''} onChange={e => onSettings({ ...settings, cachedContent: e.target.value || undefined })} />
    </label>}
    {controls.strictTools && <label className="flex gap-2 text-sm"><input type="checkbox" checked={settings.strictTools ?? false} onChange={e => onSettings({ ...settings, strictTools: e.target.checked })} />Use strict tool schemas where compatible (optional parameters retain their meaning)</label>}
    <div className="grid grid-cols-2 gap-3">{(['cacheRead', 'cacheWrite'] as const).map(key => <label key={key} className="block text-sm">{key === 'cacheRead' ? 'Cached input' : 'Cache writes'} USD / 1M tokens
      <input className={inputClass} type="number" min={0} step="any" placeholder="Unknown" value={pricing[key] ?? ''} onChange={e => onPricing({ ...pricing, [key]: e.target.value === '' ? undefined : Number(e.target.value) })} />
    </label>)}</div>
    <label className="block text-sm">Pricing source<input className={inputClass} placeholder="Provider pricing URL or contract reference" value={pricing.source ?? ''} onChange={e => onPricing({ ...pricing, source: e.target.value || undefined })} /></label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={pricing.free ?? false} onChange={e => onPricing({ ...pricing, free: e.target.checked })} />Explicitly free inference (otherwise missing rates are unknown)</label>
  </fieldset>;
}
