'use client';

import { Loader2, Telescope } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

interface Source { id: string; url: string; title: string; retrievedAt: string }
interface Section { heading: string; markdown: string; citations: string[] }
interface ReportDoc {
  question: string;
  generatedAt: string;
  depth: string;
  sections: Section[];
  sources: Source[];
  limitations: string;
}
interface Job {
  id: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  detail?: string;
  report?: ReportDoc;
  error?: string;
}

const DEPTHS = [
  { value: 'quick', label: 'Quick' },
  { value: 'standard', label: 'Standard' },
  { value: 'deep', label: 'Deep' },
];
const STAGE_LABEL: Record<string, string> = {
  planning: 'Planning sub-questions…',
  searching: 'Searching the web…',
  reading: 'Reading sources…',
  synthesizing: 'Writing the report…',
  done: 'Done',
};

export default function ResearchPage() {
  const [question, setQuestion] = useState('');
  const [depth, setDepth] = useState('standard');
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');

  const running = job?.status === 'running';

  const start = async () => {
    const q = question.trim();
    if (!q) return;
    setError('');
    setJob(null);
    try {
      const res = await api.post<{ jobId?: string; error?: string }>('/research', { question: q, depth });
      if (res.error || !res.jobId) {
        setError(res.error || 'Failed to start research');
        return;
      }
      poll(res.jobId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const poll = (jobId: string) => {
    const deadline = Date.now() + 10 * 60_000; // research is bounded; stop after ~10 min
    const tick = async () => {
      if (Date.now() > deadline) {
        setError('Research timed out.');
        setJob((j) => (j ? { ...j, status: 'error' } : j));
        return;
      }
      try {
        const j = await api.get<Job>(`/research/${jobId}`);
        setJob(j);
        if (j.status === 'running') {
          setTimeout(tick, 1200);
        } else if (j.status === 'error') {
          setError(j.error || 'Research failed');
        }
      } catch {
        setTimeout(tick, 1500);
      }
    };
    setJob({ id: jobId, status: 'running', stage: 'planning' });
    setTimeout(tick, 800);
  };

  const report = job?.report;
  const sourceNum = new Map((report?.sources ?? []).map((s, i) => [s.id, i + 1]));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xs bg-primary/10 flex items-center justify-center">
          <Telescope className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-4xl lg:text-5xl font-extrabold tracking-tighter text-on-surface">Research</h1>
          <p className="text-on-surface-variant">Ask a question — get a structured, cited report from a multi-source investigation.</p>
        </div>
      </div>

      <div className="space-y-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. What are the trade-offs between pgvector and a dedicated vector database?"
          rows={2}
          className="w-full rounded-xs border border-outline-variant/20 bg-surface px-4 py-3 text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary resize-none"
        />
        <div className="flex items-center gap-2">
          <select
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
            disabled={running}
            className="rounded-full border border-outline-variant/20 bg-surface px-3 py-2 text-sm text-on-surface"
          >
            {DEPTHS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <button
            onClick={start}
            disabled={running}
            className="px-5 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary rounded-full hover:opacity-90 disabled:opacity-50 font-medium"
          >
            {running ? 'Researching…' : 'Research'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 rounded-xs px-4 py-3 text-error text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {running && (
        <div className="flex items-center gap-2 text-on-surface-variant text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          {STAGE_LABEL[job!.stage] ?? job!.stage}
          {job!.detail && <span className="opacity-60 truncate max-w-md">· {job!.detail}</span>}
        </div>
      )}

      {report && (
        <article className="max-w-3xl space-y-6">
          <header>
            <h2 className="text-3xl font-bold tracking-tight text-on-surface">{report.question}</h2>
            <p className="text-sm text-on-surface-variant mt-1">
              {report.depth} · {report.sources.length} sources · {new Date(report.generatedAt).toLocaleString()}
            </p>
          </header>

          {report.sections.map((sec, i) => (
            <section key={i} className="space-y-2">
              <h3 className="text-xl font-semibold text-on-surface">{sec.heading}</h3>
              <p className="text-on-surface whitespace-pre-wrap leading-relaxed">{sec.markdown}</p>
              {sec.citations.length > 0 && (
                <p className="text-xs text-on-surface-variant">
                  {sec.citations.map((id) => sourceNum.get(id)).filter(Boolean).map((n) => (
                    <a key={n} href={`#src-${n}`} className="text-primary mr-1">[{n}]</a>
                  ))}
                </p>
              )}
            </section>
          ))}

          <section className="rounded-xs border border-outline-variant/10 bg-surface-container-low p-3">
            <h3 className="text-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-1">Limitations</h3>
            <p className="text-sm text-on-surface">{report.limitations}</p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-2">Sources</h3>
            <ol className="space-y-1 list-decimal pl-5">
              {report.sources.map((s, i) => (
                <li key={s.id} id={`src-${i + 1}`} className="text-sm">
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-words">{s.title}</a>
                </li>
              ))}
            </ol>
          </section>
        </article>
      )}
    </div>
  );
}
