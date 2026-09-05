'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';

// ── Types (mirrored from /api/persona) ────────────────────────────

interface PersonaState {
  id: string;
  presetId: string;
  name: string;
  pronouns: string;
  tone: string;
  narration: 'off' | 'minimal' | 'chatty';
  signaturePhrases: string[];
  userFacts: string[];
}

interface PersonaPresetSummary {
  id: string;
  displayName: string;
  name: string;
  pronouns: string;
  tone: string;
  isDefault: boolean;
  narration: string;
  signaturePhrases: string[];
}

interface PersonaResponse {
  persona: PersonaState;
  message?: string;
}

const TONES = ['dry', 'playful', 'neutral', 'professional', 'terse', 'verbose'];
const NARRATIONS: Array<PersonaState['narration']> = ['off', 'minimal', 'chatty'];

// ── Page ──────────────────────────────────────────────────────────

export default function PersonaPage() {
  const queryClient = useQueryClient();
  const [newFact, setNewFact] = useState('');
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const personaQ = useQuery({
    queryKey: ['persona', 'me'],
    queryFn: () => api.get<PersonaState>('/persona'),
  });

  const presetsQ = useQuery({
    queryKey: ['persona', 'presets'],
    queryFn: () => api.get<{ presets: PersonaPresetSummary[] }>('/persona/presets'),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['persona'] });

  const persona = personaQ.data;
  const presets = presetsQ.data?.presets ?? [];

  async function patch(body: Record<string, string>) {
    setError(null);
    try {
      await api.patch<PersonaResponse>('/persona', body);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addFact() {
    const fact = newFact.trim();
    if (fact.length < 4) {
      setError('Fact must be at least 4 characters.');
      return;
    }
    setError(null);
    try {
      await api.post<PersonaResponse>('/persona/facts', { fact });
      setNewFact('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeFact(idx: number) {
    setError(null);
    try {
      await api.delete<PersonaResponse>(`/persona/facts/${idx}`);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function reset() {
    if (!confirm('Reset persona to the Octipus default? Free-form facts and the custom name will be lost.')) return;
    setError(null);
    try {
      await api.post<PersonaResponse>('/persona/reset');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (personaQ.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-on-surface-variant font-mono">
        <Loader2 className="h-5 w-5 animate-spin" /> <span className="ml-2">loading persona…</span>
      </div>
    );
  }

  if (personaQ.isError || !persona) {
    return (
      <div className="p-8 text-error">
        <p>Failed to load persona: {(personaQ.error as Error)?.message || 'unknown error'}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8 text-on-surface">
      <PageHeader
        title="persona"
        description={'octi’s identity and voice. per-user, applied across every channel — tui, web, telegram, slack. the base persona is Octipus, an octopus-machine collective that talks about itself in the third person and uses "we" for its swarm.'}
      />

      {error && (
        <div className="rounded-xs border border-error/40 bg-error-container/40 p-3 text-sm text-error">
          {error}
        </div>
      )}

      {/* ── Identity ─────────────────────────────────────── */}
      <section className="rounded-xs term-frame p-5">
        <h2 className="mb-4 section-label">Identity</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-on-surface-variant">Name</span>
            <input
              type="text"
              value={pendingName ?? persona.name}
              onChange={e => setPendingName(e.target.value)}
              onBlur={() => {
                if (pendingName !== null && pendingName !== persona.name) {
                  void patch({ name: pendingName });
                }
                setPendingName(null);
              }}
              className="mt-1 w-full rounded-xs border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
              maxLength={40}
              placeholder="Octipus"
            />
            <span className="mt-1 block text-[10px] text-on-surface-variant">Pronouns: {persona.pronouns}</span>
          </label>

          <label className="block">
            <span className="text-xs text-on-surface-variant">Tone</span>
            <select
              value={persona.tone}
              onChange={e => void patch({ tone: e.target.value })}
              className="mt-1 w-full rounded-xs border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
            >
              {TONES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-on-surface-variant">Narration volume</span>
            <select
              value={persona.narration}
              onChange={e => void patch({ narration: e.target.value })}
              className="mt-1 w-full rounded-xs border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
            >
              {NARRATIONS.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-on-surface-variant">
              How chatty the live swarm narration is.
            </span>
          </label>

          <label className="block">
            <span className="text-xs text-on-surface-variant">Active preset</span>
            <select
              value={persona.presetId}
              onChange={e => void patch({ presetId: e.target.value })}
              className="mt-1 w-full rounded-xs border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
            >
              {presets.map(p => (
                <option key={p.id} value={p.id}>
                  {p.displayName}{p.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-on-surface-variant">
              Switching keeps your custom name. Reset below if you want a clean slate.
            </span>
          </label>
        </div>
      </section>

      {/* ── Self-facts ──────────────────────────────────── */}
      <section className="rounded-xs term-frame p-5">
        <h2 className="mb-2 section-label">
          Self-facts
        </h2>
        <p className="mb-4 text-xs text-on-surface-variant">
          Free-form rules octi should follow about itself. Re-injected
          on every turn. Example: <em>&quot;Always summarize in bullets&quot;</em>,
          <em> &quot;Stop apologizing for slow responses&quot;</em>.
        </p>

        {persona.userFacts.length === 0 ? (
          <p className="text-[12px] font-mono text-on-surface-variant">
            <span aria-hidden className="text-outline mr-2">[ ]</span>no self-facts set
          </p>
        ) : (
          <ul className="space-y-2">
            {persona.userFacts.map((fact, idx) => (
              <li
                key={`${idx}-${fact}`}
                className="flex items-start justify-between gap-2 rounded-xs border border-outline-variant bg-surface-container-low px-3 py-2 text-sm"
              >
                <span className="flex-1">{fact}</span>
                <button
                  type="button"
                  aria-label="Remove fact"
                  onClick={() => void removeFact(idx)}
                  className="text-on-surface-variant transition hover:text-error"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={newFact}
            onChange={e => setNewFact(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void addFact();
            }}
            placeholder="Add a self-fact (4–280 chars)…"
            maxLength={280}
            className="flex-1 rounded-xs border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void addFact()}
            className="flex items-center gap-1 rounded-xs border border-outline-variant bg-surface-container-high px-3 py-2 text-sm text-on-surface transition hover:border-outline"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>
      </section>

      {/* ── Preset gallery ──────────────────────────────── */}
      <section className="rounded-xs term-frame p-5">
        <h2 className="mb-4 section-label">
          Available presets
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {presets.map(p => (
            <div
              key={p.id}
              className={`rounded border p-3 text-sm transition ${
                p.id === persona.presetId
                  ? 'border-emerald-700 bg-emerald-900/20'
                  : 'border-zinc-800 bg-zinc-950'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{p.displayName}</span>
                <span className="text-[10px] uppercase tracking-wider text-on-surface-variant">{p.tone}</span>
              </div>
              <div className="mt-1 text-xs text-on-surface-variant">id: {p.id}{p.isDefault ? ' · default' : ''}</div>
              {p.signaturePhrases.length > 0 && (
                <div className="mt-2 text-xs italic text-on-surface-variant">
                  &ldquo;{p.signaturePhrases[0]}&rdquo;
                </div>
              )}
              {p.id !== persona.presetId && (
                <button
                  type="button"
                  onClick={() => void patch({ presetId: p.id })}
                  className="mt-2 text-xs text-emerald-400 transition hover:text-emerald-300"
                >
                  Use this preset
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Reset ───────────────────────────────────────── */}
      <section className="flex justify-end">
        <button
          type="button"
          onClick={() => void reset()}
          className="flex items-center gap-2 rounded border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-error/40 hover:text-error"
        >
          <RotateCcw className="h-4 w-4" /> Reset to Octipus default
        </button>
      </section>
    </div>
  );
}
