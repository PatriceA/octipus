'use client';

import { Clock, FileText, Languages, Loader2, Newspaper, Sparkles, Wand2, ListChecks, HelpCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

interface ReaderDoc {
  url: string;
  title: string;
  byline?: string;
  siteName?: string;
  publishedAt?: string;
  leadImage?: string;
  contentHtml: string;
  textContent: string;
  wordCount: number;
  estReadMinutes: number;
}

interface ActionResult {
  action: string;
  output: string;
  items?: string[];
}

type ActionKind = 'summarize' | 'simplify' | 'translate' | 'action_items' | 'ask';

const ACTIONS: { kind: ActionKind; label: string; icon: typeof FileText; needsArg?: string }[] = [
  { kind: 'summarize', label: 'Summarize', icon: FileText },
  { kind: 'simplify', label: 'Simplify', icon: Wand2 },
  { kind: 'translate', label: 'Translate', icon: Languages, needsArg: 'Target language (e.g. French)' },
  { kind: 'action_items', label: 'Action items', icon: ListChecks },
  { kind: 'ask', label: 'Ask', icon: HelpCircle, needsArg: 'Your question about the article' },
];

export default function ReaderPage() {
  const [url, setUrl] = useState('');
  const [doc, setDoc] = useState<ReaderDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [actionLoading, setActionLoading] = useState<ActionKind | null>(null);

  const read = async () => {
    const u = url.trim();
    if (!u) return;
    setLoading(true);
    setError('');
    setResult(null);
    setDoc(null);
    try {
      const res = await api.post<ReaderDoc & { error?: string }>('/reader', { url: u });
      if (res.error) setError(res.error);
      else setDoc(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const runAction = async (kind: ActionKind, needsArg?: string) => {
    if (!doc) return;
    let argument: string | undefined;
    if (needsArg) {
      argument = window.prompt(needsArg) || undefined;
      if (!argument) return;
    }
    setActionLoading(kind);
    setResult(null);
    setError('');
    try {
      const res = await api.post<ActionResult & { error?: string }>('/reader/action', {
        url: doc.url,
        text: doc.textContent,
        action: kind,
        argument,
      });
      if (res.error) setError(res.error);
      else setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xs bg-primary/10 flex items-center justify-center">
          <Newspaper className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-4xl lg:text-5xl font-extrabold tracking-tighter text-on-surface">Reader</h1>
          <p className="text-on-surface-variant">Paste a link for a clean, distraction-free read — then summarize, simplify, translate, or ask.</p>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && read()}
          placeholder="https://example.com/article"
          className="flex-1 rounded-full border border-outline-variant/20 bg-surface px-4 py-2 text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary"
        />
        <button
          onClick={read}
          disabled={loading}
          className="px-5 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary rounded-full hover:opacity-90 disabled:opacity-50 font-medium"
        >
          {loading ? 'Reading…' : 'Read'}
        </button>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 rounded-xs px-4 py-3 text-error text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {doc && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-6 items-start">
          <article className="min-w-0 max-w-2xl mx-auto lg:mx-0">
            <h2 className="text-3xl font-bold tracking-tight text-on-surface">{doc.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-on-surface-variant">
              {doc.siteName && <span>{doc.siteName}</span>}
              {doc.byline && <span>· {doc.byline}</span>}
              {doc.publishedAt && <span>· {new Date(doc.publishedAt).toLocaleDateString()}</span>}
              <span className="inline-flex items-center gap-1">· <Clock className="w-3.5 h-3.5" /> {doc.estReadMinutes} min · {doc.wordCount} words</span>
            </div>
            {doc.leadImage && (
              // eslint-disable-next-line @next/next/no-img-element -- remote article image, dimensions unknown
              <img src={doc.leadImage} alt="" className="mt-4 rounded-xs max-h-80 w-full object-cover" />
            )}
            {/* Server-sanitized allowlist HTML (see src/core/reader/extract.ts). */}
            <div
              className="reader-content mt-6 prose-reader text-on-surface leading-relaxed space-y-4"
              dangerouslySetInnerHTML={{ __html: doc.contentHtml }}
            />
          </article>

          <aside className="lg:sticky lg:top-4 space-y-3">
            <div className="rounded-xs border border-outline-variant/10 bg-surface-container-low p-3 space-y-2">
              <h3 className="text-sm font-semibold text-on-surface flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-primary" /> AI actions
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {ACTIONS.map(({ kind, label, icon: Icon, needsArg }) => (
                  <button
                    key={kind}
                    onClick={() => runAction(kind, needsArg)}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-1.5 px-2.5 py-2 text-sm rounded-xs border border-outline-variant/20 hover:bg-surface-container-high disabled:opacity-50 text-on-surface"
                  >
                    {actionLoading === kind ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {result && (
              <div className="rounded-xs border border-outline-variant/10 bg-surface p-3">
                <h3 className="text-xs uppercase tracking-wide text-on-surface-variant mb-2">{result.action.replace('_', ' ')}</h3>
                {result.items && result.items.length > 0 ? (
                  <ul className="list-disc pl-5 space-y-1 text-sm text-on-surface">
                    {result.items.map((it, i) => <li key={i}>{it}</li>)}
                  </ul>
                ) : (
                  <p className="text-sm text-on-surface whitespace-pre-wrap">{result.output}</p>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
