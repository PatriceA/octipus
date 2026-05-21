'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
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
      <div className="flex h-screen items-center justify-center text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" /> <span className="ml-2">Loading persona…</span>
      </div>
    );
  }

  if (personaQ.isError || !persona) {
    return (
      <div className="p-8 text-red-400">
        <p>Failed to load persona: {(personaQ.error as Error)?.message || 'unknown error'}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8 text-zinc-100">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Persona</h1>
        <p className="mt-2 text-sm text-zinc-400">
          The orchestrator&apos;s identity and voice. Per-user. Applies across every channel — TUI, web, Telegram, Slack. The base persona is <em>Octipus</em>, an octopus-machine collective that talks about itself in the third person and uses &quot;we&quot; for its swarm.
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-700 bg-red-900/30 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* ── Identity ─────────────────────────────────────── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">Identity</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-zinc-400">Name</span>
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
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
              maxLength={40}
              placeholder="Octipus"
            />
            <span className="mt-1 block text-[10px] text-zinc-500">Pronouns: {persona.pronouns}</span>
          </label>

          <label className="block">
            <span className="text-xs text-zinc-400">Tone</span>
            <select
              value={persona.tone}
              onChange={e => void patch({ tone: e.target.value })}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
            >
              {TONES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-zinc-400">Narration volume</span>
            <select
              value={persona.narration}
              onChange={e => void patch({ narration: e.target.value })}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
            >
              {NARRATIONS.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-zinc-500">
              How chatty the live swarm narration is.
            </span>
          </label>

          <label className="block">
            <span className="text-xs text-zinc-400">Active preset</span>
            <select
              value={persona.presetId}
              onChange={e => void patch({ presetId: e.target.value })}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
            >
              {presets.map(p => (
                <option key={p.id} value={p.id}>
                  {p.displayName}{p.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-zinc-500">
              Switching keeps your custom name. Reset below if you want a clean slate.
            </span>
          </label>
        </div>
      </section>

      {/* ── Self-facts ──────────────────────────────────── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
          Self-facts
        </h2>
        <p className="mb-4 text-xs text-zinc-500">
          Free-form rules the orchestrator should follow about itself. Re-injected
          on every turn. Example: <em>&quot;Always summarize in bullets&quot;</em>,
          <em> &quot;Stop apologizing for slow responses&quot;</em>.
        </p>

        {persona.userFacts.length === 0 ? (
          <p className="text-sm italic text-zinc-500">No self-facts set.</p>
        ) : (
          <ul className="space-y-2">
            {persona.userFacts.map((fact, idx) => (
              <li
                key={`${idx}-${fact}`}
                className="flex items-start justify-between gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
              >
                <span className="flex-1">{fact}</span>
                <button
                  type="button"
                  aria-label="Remove fact"
                  onClick={() => void removeFact(idx)}
                  className="text-zinc-500 transition hover:text-red-400"
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
            className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void addFact()}
            className="flex items-center gap-1 rounded bg-zinc-700 px-3 py-2 text-sm text-zinc-100 transition hover:bg-zinc-600"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>
      </section>

      {/* ── Preset gallery ──────────────────────────────── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">
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
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">{p.tone}</span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">id: {p.id}{p.isDefault ? ' · default' : ''}</div>
              {p.signaturePhrases.length > 0 && (
                <div className="mt-2 text-xs italic text-zinc-400">
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
          className="flex items-center gap-2 rounded border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-red-700 hover:text-red-300"
        >
          <RotateCcw className="h-4 w-4" /> Reset to Octipus default
        </button>
      </section>
    </div>
  );
}
