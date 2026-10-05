'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { PersonalModelSummary, PersonalModelsResponse } from '../../../src/shared/types';

/**
 * Settings → My models (coworking spec §8.4).
 *
 * The caller's own models: a provider and model id with their own key (or a
 * CLI token), optionally bound to text lanes so their turns run on it. Only
 * the owner ever sees or uses these rows; the key is write-only here — the
 * server never returns it. A custom provider takes an endpoint, which must be
 * a public address (checked again on every request).
 */

const CUSTOM_PROVIDERS = new Set(['custom-openai', 'custom-anthropic', 'custom-gemini']);
const SLUG = /^[a-z0-9-]{1,40}$/;

function LaneCheckboxes({ topics, value, onChange, idPrefix }: {
  topics: string[];
  value: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
}) {
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="sr-only">Lanes</legend>
      {topics.map((t) => (
        <label key={t} htmlFor={`${idPrefix}-${t}`} className="flex items-center gap-1.5 text-xs text-on-surface">
          <input
            id={`${idPrefix}-${t}`}
            type="checkbox"
            checked={value.includes(t)}
            onChange={(e) => onChange(e.target.checked ? [...value, t] : value.filter((x) => x !== t))}
          />
          {t}
        </label>
      ))}
    </fieldset>
  );
}

function ModelRow({ model, topics, onError }: { model: PersonalModelSummary; topics: string[]; onError: (msg: string | null) => void }) {
  const queryClient = useQueryClient();
  const [lanes, setLanes] = useState<string[]>(model.topics);
  const [key, setKey] = useState('');
  // A saved rebinding comes back from the server: show what is stored.
  const savedLanes = model.topics.join(',');
  const [syncedLanes, setSyncedLanes] = useState(savedLanes);
  if (syncedLanes !== savedLanes) {
    setSyncedLanes(savedLanes);
    setLanes(model.topics);
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['me', 'models'] });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/me/models/${model.slug}`, body),
    onSuccess: () => { onError(null); setKey(''); invalidate(); },
    onError: (err: Error) => onError(err.message),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/me/models/${model.slug}`),
    onSuccess: () => { onError(null); invalidate(); },
    onError: (err: Error) => onError(err.message),
  });

  const lanesChanged = [...lanes].sort().join(',') !== [...model.topics].sort().join(',');

  return (
    <li className="px-4 py-3 space-y-2 text-sm" aria-label={`Model ${model.slug}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Cpu className="w-4 h-4 text-on-surface-variant shrink-0" aria-hidden />
        <span className="text-on-surface flex-1 min-w-0 break-all">
          {model.label || model.slug}
          <span className="text-on-surface-variant"> · {model.provider} · {model.modelId}</span>
          {model.endpoint && <span className="text-on-surface-variant"> · {model.endpoint}</span>}
          {!model.isEnabled && <span className="text-on-surface-variant"> · disabled</span>}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-on-surface-variant">
          <input
            type="checkbox"
            checked={model.isEnabled}
            onChange={(e) => update.mutate({ isEnabled: e.target.checked })}
            aria-label={`Enable ${model.slug}`}
          />
          enabled
        </label>
        <button
          type="button"
          onClick={() => { if (confirm(`Delete ${model.label || model.slug}? Its key is deleted too.`)) remove.mutate(); }}
          aria-label={`Delete ${model.slug}`}
          title="Delete model"
          className="text-on-surface-variant/60 hover:text-error cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 pl-7">
        <span className="text-xs text-on-surface-variant">Runs my</span>
        <LaneCheckboxes topics={topics} value={lanes} onChange={setLanes} idPrefix={`lane-${model.slug}`} />
        {lanesChanged && (
          <button
            type="button"
            onClick={() => update.mutate({ topics: lanes })}
            className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs"
          >
            Save lanes
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-7">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={model.hasKey ? 'replace key…' : 'key or token'}
          aria-label={`New key for ${model.slug}`}
          className="px-2 py-1 bg-surface-container-high border border-outline-variant rounded-xs text-xs w-64"
          autoComplete="off"
        />
        {key && (
          <button type="button" onClick={() => update.mutate({ key })} className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs">
            Replace key
          </button>
        )}
      </div>
    </li>
  );
}

export function MyModelsTab() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const [provider, setProvider] = useState('');
  const [modelId, setModelId] = useState('');
  const [label, setLabel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [key, setKey] = useState('');
  const [lanes, setLanes] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['me', 'models'],
    queryFn: () => api.get<PersonalModelsResponse>('/me/models'),
  });
  const providers = data?.providers ?? [];
  const topics = data?.topics ?? [];
  const models = data?.models ?? [];
  const chosenProvider = provider || providers[0] || '';
  const isCustom = CUSTOM_PROVIDERS.has(chosenProvider);

  const create = useMutation({
    mutationFn: () => api.post('/me/models', {
      slug,
      provider: chosenProvider,
      modelId: modelId.trim(),
      key,
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(isCustom ? { endpoint: endpoint.trim() } : {}),
      topics: lanes,
    }),
    onSuccess: () => {
      setError(null);
      setSlug(''); setModelId(''); setLabel(''); setEndpoint(''); setKey(''); setLanes([]);
      queryClient.invalidateQueries({ queryKey: ['me', 'models'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const canCreate = SLUG.test(slug) && !!chosenProvider && !!modelId.trim() && !!key && (!isCustom || !!endpoint.trim());

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-extrabold tracking-tighter text-on-surface">My models</h2>
        <p className="text-sm text-on-surface-variant mt-1">
          Bring your own model: your key, your bill. Bind it to a lane and your own turns run on it — in your
          sessions and in shared spaces alike. Nobody else can see or use it, and admins cannot change it.
        </p>
      </div>

      {error && <p role="alert" className="text-xs text-error">! {error}</p>}

      <form
        aria-label="Add a model"
        className="p-4 bg-surface-container-low rounded-lg space-y-3"
        onSubmit={(e) => { e.preventDefault(); if (canCreate) create.mutate(); }}
      >
        <h3 className="font-medium text-on-surface text-sm">Add a model</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-xs text-on-surface-variant space-y-1">
            <span>Short name</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="my-claude"
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded-xs text-sm text-on-surface"
            />
          </label>
          <label className="text-xs text-on-surface-variant space-y-1">
            <span>Provider</span>
            <select
              value={chosenProvider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded-xs text-sm text-on-surface"
            >
              {providers.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="text-xs text-on-surface-variant space-y-1">
            <span>Model id</span>
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder={chosenProvider === 'cli' ? 'cli/claude-code' : 'provider model id'}
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded-xs text-sm text-on-surface"
            />
          </label>
          <label className="text-xs text-on-surface-variant space-y-1">
            <span>Label (optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded-xs text-sm text-on-surface"
            />
          </label>
          {isCustom && (
            <label className="text-xs text-on-surface-variant space-y-1 md:col-span-2">
              <span>Endpoint</span>
              <input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://gateway.example.com"
                className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded-xs text-sm text-on-surface"
              />
            </label>
          )}
          <label className="text-xs text-on-surface-variant space-y-1 md:col-span-2">
            <span>{chosenProvider === 'cli' ? 'CLI token' : 'API key'}</span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded-xs text-sm text-on-surface"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-on-surface-variant">Use for my</span>
          <LaneCheckboxes topics={topics} value={lanes} onChange={setLanes} idPrefix="new-lane" />
        </div>
        <button
          type="submit"
          disabled={!canCreate || create.isPending}
          className="px-3 py-2 rounded-xs bg-primary text-on-primary text-sm disabled:opacity-50"
        >
          Add model
        </button>
      </form>

      {isLoading ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : models.length === 0 ? (
        <div className="p-4 text-center text-xs text-on-surface-variant border border-outline-variant/40 rounded-xs border-dashed">
          no personal models yet
        </div>
      ) : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {models.map((m) => <ModelRow key={m.name} model={m} topics={topics} onError={setError} />)}
        </ul>
      )}
    </div>
  );
}
