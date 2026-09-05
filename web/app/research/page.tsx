'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '@/components/ui/markdown-renderer';
import { PageHeader } from '@/components/ui/page-header';
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
  documentId?: string;
  taskId?: string;
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
      <PageHeader
        title="research"
        description="ask a question — get a structured, cited report from a multi-source investigation"
        badge={
          running ? (
            <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 border border-accent/50 bg-accent-container/40 rounded-xs text-[10px] uppercase tracking-wider text-accent">
              <span className="dot dot-live bg-accent text-accent w-1.5 h-1.5" />
              running
            </span>
          ) : undefined
        }
      />

      <div className="space-y-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. What are the trade-offs between pgvector and a dedicated vector database?"
          rows={2}
          className="w-full rounded-xs border border-outline-variant bg-surface-container px-4 py-3 text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-accent resize-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          {DEPTHS.map((d) => (
            <button
              key={d.value}
              onClick={() => setDepth(d.value)}
              disabled={running}
              className={`px-2.5 py-1.5 text-[12px] rounded-xs border transition-colors cursor-pointer disabled:opacity-50 ${
                depth === d.value
                  ? 'border-accent/50 bg-accent-container/40 text-accent font-semibold'
                  : 'border-outline-variant text-on-surface-variant hover:text-on-surface'
              }`}
            >
              --{d.value}
            </button>
          ))}
          <button
            onClick={start}
            disabled={running}
            className="ml-auto px-5 py-2 bg-accent text-on-accent rounded-xs hover:bg-accent-dim disabled:opacity-50 font-semibold text-[13px]"
          >
            {running ? 'researching…' : 'execute'}
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
        <div className="flex items-center gap-2 text-on-surface-variant text-sm border border-accent/40 bg-surface-container glow-pink rounded-xs px-4 py-3 animate-enter">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          <span className="text-accent">{STAGE_LABEL[job!.stage] ?? job!.stage}</span>
          <span aria-hidden className="term-caret" />
          {job!.detail && <span className="opacity-60 truncate max-w-md">· {job!.detail}</span>}
        </div>
      )}

      {report && (
        <article className="max-w-3xl space-y-6 stagger">
          <header>
            <h2 className="text-3xl font-bold tracking-tight text-on-surface">{report.question}</h2>
            <p className="text-sm text-on-surface-variant mt-1">
              {report.depth} · {report.sources.length} sources · {new Date(report.generatedAt).toLocaleString()}
            </p>
            {job?.documentId && (
              <p className="text-sm mt-2">
                <a href="/documents" className="text-primary hover:underline">
                  Saved to Documents &amp; added to the knowledge base →
                </a>
              </p>
            )}
            {job?.taskId && (
              <p className="text-sm mt-1">
                <a href="/tasks" className="text-primary hover:underline">
                  A review to-do was added to your list →
                </a>
              </p>
            )}
          </header>

          {report.sections.map((sec, i) => (
            <section key={i} className="space-y-2">
              <h3 className="text-base font-semibold text-on-surface"><span aria-hidden className="text-accent/70">{'// '}</span>{sec.heading}</h3>
              <Markdown content={sec.markdown} className="text-on-surface" />
              {sec.citations.length > 0 && (
                <p className="text-xs text-on-surface-variant">
                  {sec.citations.map((id) => sourceNum.get(id)).filter(Boolean).map((n) => (
                    <a key={n} href={`#src-${n}`} className="text-accent mr-1">[{n}]</a>
                  ))}
                </p>
              )}
            </section>
          ))}

          <section className="rounded-xs border border-warning/30 bg-surface-container-low p-3">
            <h3 className="section-label mb-1">limitations</h3>
            <Markdown content={report.limitations} className="text-on-surface" />
          </section>

          <section>
            <h3 className="section-label mb-2">sources</h3>
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
