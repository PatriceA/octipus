'use client';

import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkWikilink } from '@/lib/remark-wikilink';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Shared markdown rendering.
//
// Extracted from the chat timeline so every surface that shows markdown —
// chat messages, Deep Research reports, the document/file preview, notes —
// renders it the same way instead of dumping raw `*`/`#`/`|` characters.
// remark-gfm adds tables, task lists, strikethrough and autolinks; code
// fences route through CodeBlock so the copy button stays consistent.
// ---------------------------------------------------------------------------

export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="relative my-3 rounded-xs bg-surface-container-lowest text-gray-100 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-1.5 bg-surface-container-low text-xs text-on-surface-variant">
        <span>{language || 'text'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-on-surface transition-colors"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * Render a markdown string. `className` is applied to the wrapper so callers
 * can tune spacing/typography for their surface (e.g. a denser chat bubble vs
 * a roomier document preview).
 */
export function Markdown({
  content,
  className,
  onWikilink,
  onTag,
}: {
  content: string;
  className?: string;
  /** When set, `[[wikilinks]]` render as clickable links that open a note by slug. */
  onWikilink?: (slug: string) => void;
  /** When set, inline `#tags` render as clickable chips. */
  onTag?: (tag: string) => void;
}) {
  const enableInline = !!(onWikilink || onTag);
  return (
    <div className={cn('space-y-2 text-sm leading-relaxed', className)}>
      <ReactMarkdown
        remarkPlugins={enableInline ? [remarkGfm, remarkWikilink] : [remarkGfm]}
        urlTransform={
          enableInline
            ? (url) => (url.startsWith('wikilink:') || url.startsWith('tag:') ? url : defaultUrlTransform(url))
            : undefined
        }
        components={{
          code({ inline, className: codeClassName, children, ...props }: {
            inline?: boolean;
            className?: string;
            children?: React.ReactNode;
          } & React.HTMLAttributes<HTMLElement>) {
            const text = String(children ?? '').replace(/\n$/, '');
            // Heuristic — if the model wraps a short single-line token
            // (command, container name, file path) in a fenced block
            // without specifying a language, render it as inline code so
            // prose keeps flowing. Multi-line content, language-tagged
            // blocks, and anything over ~80 chars still go through the
            // full CodeBlock (with copy button).
            const match = /language-(\w+)/.exec(codeClassName || '');
            const looksLikeAccidentalFence =
              !inline &&
              !match &&
              !text.includes('\n') &&
              text.length > 0 &&
              text.length <= 80;
            if (inline || looksLikeAccidentalFence) {
              return (
                <code
                  className="bg-surface-container-highest px-1 py-0.5 rounded font-mono text-sm"
                  {...props}
                >
                  {text}
                </code>
              );
            }
            return <CodeBlock language={match?.[1] || 'text'} code={text} />;
          },
          p({ children }) {
            return <p className="whitespace-pre-wrap">{children}</p>;
          },
          h1({ children }) {
            return <h1 className="text-lg font-semibold mt-3 mb-1">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-base font-semibold mt-3 mb-1">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-outline-variant/40 pl-3 text-on-surface-variant italic">
                {children}
              </blockquote>
            );
          },
          // GFM tables — overflow-x so wide tables scroll instead of bleeding
          // out of the container. The container caps width via the parent.
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="border-collapse text-sm">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-surface-container-high">{children}</thead>;
          },
          th({ children }) {
            return (
              <th className="border border-outline-variant/20 px-2 py-1 text-left font-semibold">
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="border border-outline-variant/20 px-2 py-1 align-top">{children}</td>;
          },
          a({ href, children }) {
            // In-app wikilink — open the note by slug.
            if (onWikilink && href?.startsWith('wikilink:')) {
              const slug = href.slice('wikilink:'.length);
              return (
                <button
                  type="button"
                  onClick={() => onWikilink(slug)}
                  className="text-primary underline decoration-dotted underline-offset-2 hover:opacity-80"
                >
                  {children}
                </button>
              );
            }
            // Inline tag chip — filter by tag.
            if (onTag && href?.startsWith('tag:')) {
              const tag = href.slice('tag:'.length);
              return (
                <button
                  type="button"
                  onClick={() => onTag(tag)}
                  className="inline-flex items-center rounded bg-primary-container/40 px-1 text-[0.85em] text-primary hover:bg-primary-container/70"
                >
                  {children}
                </button>
              );
            }
            return (
              <a
                href={href ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline hover:opacity-80"
              >
                {children}
              </a>
            );
          },
          ul({ children }) {
            return <ul className="list-disc pl-5 space-y-0.5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal pl-5 space-y-0.5">{children}</ol>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
