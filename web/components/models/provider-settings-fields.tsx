'use client';
import { useState } from 'react';
import { providerControls, type ModelPricing, type ProviderSettings } from '../../../src/shared/provider-settings';

type MediaPriceKey = 'perImage' | 'perAudioMinute' | 'perMillionChars';

const MEDIA_PRICES: Array<{ key: MediaPriceKey; lane: string; label: string; meantFor: RegExp }> = [
  { key: 'perImage', lane: 'image_generation', label: 'USD per generated image', meantFor: /gpt-image|dall-e|imagen|flux|stable-diffusion|sdxl|(?:^|[-/])image(?:$|[-:])|flash-image|nano-banana/i },
  { key: 'perAudioMinute', lane: 'transcription', label: 'USD per audio minute transcribed', meantFor: /transcri|whisper/i },
  { key: 'perMillionChars', lane: 'speech', label: 'USD per 1M characters spoken', meantFor: /tts|speech|kokoro|piper/i },
];

/**
 * Which media rates apply to a row: the lane it is bound to, or a model id
 * that is plainly meant for one (gpt-image-1, whisper-1, gpt-4o-mini-tts).
 * A rate already set always shows. The rest stay under "Media pricing".
 */
function relevantMediaPrices(modelId: string, topics: readonly string[], pricing: ModelPricing): Set<MediaPriceKey> {
  return new Set(MEDIA_PRICES.filter(p => topics.includes(p.lane) || p.meantFor.test(modelId) || pricing[p.key] !== undefined).map(p => p.key));
}

export function ProviderSettingsFields({ provider, model, topics = [], settings, pricing, controls: serverControls, onSettings, onPricing }: {
  provider: string; model: string; topics?: readonly string[]; controls?: ReturnType<typeof providerControls>; settings: ProviderSettings; pricing: ModelPricing;
  onSettings: (s: ProviderSettings) => void; onPricing: (p: ModelPricing) => void;
}) {
  const controls = serverControls ?? providerControls(provider, model);
  const inputClass = 'w-full rounded-lg bg-surface-container-high px-3 py-2 text-on-surface border border-outline-variant/10';
  // Computed from the saved row, not the live edit, so a field does not jump
  // into the collapsible when its value is cleared.
  const [relevant] = useState(() => relevantMediaPrices(model, topics, pricing));
  const mediaField = (p: typeof MEDIA_PRICES[number]) => <label key={p.key} className="block text-sm">{p.label}
    <input className={inputClass} type="number" min={0} step="any" placeholder="Unknown" data-testid={`pricing-${p.key}`} value={pricing[p.key] ?? ''} onChange={e => onPricing({ ...pricing, [p.key]: e.target.value === '' ? undefined : Number(e.target.value) })} />
  </label>;
  const shown = MEDIA_PRICES.filter(p => relevant.has(p.key));
  const others = MEDIA_PRICES.filter(p => !relevant.has(p.key));
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
        <option value="default">Provider default</option><option value="session">Long sessions (longer cache lifetime, session key)</option><option value="off">Disable Octipus cache hints</option>
      </select><span className="text-xs text-on-surface-variant">Upstream automatic caching may still apply.</span>
    </label>}
    {controls.cachedContent && <label className="block text-sm">Existing Gemini cache reference
      <input className={inputClass} placeholder="cachedContents/…" value={settings.cachedContent ?? ''} onChange={e => onSettings({ ...settings, cachedContent: e.target.value || undefined })} />
    </label>}
    {controls.strictTools && <label className="flex gap-2 text-sm"><input type="checkbox" checked={settings.strictTools ?? false} onChange={e => onSettings({ ...settings, strictTools: e.target.checked })} />Use strict tool schemas where compatible (optional parameters retain their meaning)</label>}
    <div className="grid grid-cols-2 gap-3">{(['cacheRead', 'cacheWrite'] as const).map(key => <label key={key} className="block text-sm">{key === 'cacheRead' ? 'Cached input' : 'Cache writes'} USD / 1M tokens
      <input className={inputClass} type="number" min={0} step="any" placeholder="Unknown" value={pricing[key] ?? ''} onChange={e => onPricing({ ...pricing, [key]: e.target.value === '' ? undefined : Number(e.target.value) })} />
    </label>)}</div>
    {shown.length > 0 && <div className="grid grid-cols-2 gap-3">{shown.map(mediaField)}</div>}
    {others.length > 0 && <details className="text-sm" data-testid="media-pricing">
      <summary className="cursor-pointer text-on-surface-variant">Media pricing</summary>
      <p className="text-xs text-on-surface-variant mt-1">For a row used for image generation, transcription or speech. Unset uses the list price where one is known.</p>
      <div className="grid grid-cols-2 gap-3 mt-2">{others.map(mediaField)}</div>
    </details>}
    <label className="block text-sm">Pricing source<input className={inputClass} placeholder="Provider pricing URL or contract reference" value={pricing.source ?? ''} onChange={e => onPricing({ ...pricing, source: e.target.value || undefined })} /></label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={pricing.free ?? false} onChange={e => onPricing({ ...pricing, free: e.target.checked })} />Explicitly free inference (otherwise missing rates are unknown)</label>
  </fieldset>;
}
