'use client';

/**
 * Assistant text with interactive answers: stored replies carry marker lines
 * (`[[octi-ui:<id>|<title>]]`) rendered as blocks; a reply still streaming
 * carries the raw fence, rendered as a static preview that fills in as the
 * markup arrives (scripts never run in a preview).
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  findInlineUiFences,
  inlineUiFallbackLine,
  inlineUiFallbackText,
  mentionsInlineUiLang,
  previewInlineUiBody,
  splitInlineUiSegments,
} from '../../../../src/shared/inline-ui/fence';
import { clampInlineUiHeight } from '../../../../src/shared/inline-ui/limits';
import { Markdown } from '@/components/ui/markdown-renderer';
import { useInlineUiHost } from './context';
import { InlineUiBlock } from './block';
import { InlineUiFrame } from './frame';

export function AssistantContent({ content, untrusted }: { content: string; untrusted?: boolean }) {
  const host = useInlineUiHost();
  const segments = useMemo(() => splitInlineUiSegments(content), [content]);
  if (segments.length === 1 && segments[0].kind === 'text') return <Markdown content={content} untrusted={untrusted} />;
  if (!host) return <Markdown content={inlineUiFallbackText(content)} untrusted={untrusted} />;
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === 'text'
          ? <Markdown key={`t${i}`} content={segment.text} untrusted={untrusted} />
          : <InlineUiBlock key={`b${i}:${segment.id}`} id={segment.id} title={segment.title} />,
      )}
    </>
  );
}

export function StreamingContent({ text }: { text: string }) {
  const host = useInlineUiHost();
  const fences = useMemo(() => (mentionsInlineUiLang(text) ? findInlineUiFences(text) : []), [text]);
  if (fences.length === 0) return <div className="text-sm whitespace-pre-wrap break-words min-w-0">{text}</div>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const fence of fences) {
    const before = text.slice(cursor, fence.start);
    if (before.trim()) parts.push(<div key={`t${cursor}`} className="text-sm whitespace-pre-wrap break-words">{before}</div>);
    parts.push(host
      ? <InlineUiPreview key={`f${fence.start}`} title={fence.title} body={fence.body} height={fence.height} />
      : <p key={`f${fence.start}`} className="text-sm text-on-surface-variant">{inlineUiFallbackLine(fence.title)}</p>);
    cursor = fence.end;
  }
  const after = text.slice(cursor);
  if (after.trim()) parts.push(<div key={`t${cursor}`} className="text-sm whitespace-pre-wrap break-words">{after}</div>);
  return <div className="min-w-0 flex-1 space-y-1" data-testid="inline-ui-streaming">{parts}</div>;
}

/** A static preview of a block being written: the first content, then `update`s at most every 300 ms. */
function InlineUiPreview({ title, body, height }: { title: string; body: string; height?: number }) {
  const latest = useRef(body);
  useEffect(() => { latest.current = body; });
  const [initial] = useState(() => previewInlineUiBody(body));
  const [update, setUpdate] = useState<{ html: string; css: string } | undefined>(undefined);
  const [measured, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = previewInlineUiBody(latest.current);
      setUpdate((prev) => (prev && prev.html === next.html && prev.css === next.css ? prev : next));
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="my-1 rounded-lg border border-dashed border-outline-variant/50 overflow-hidden" data-testid="inline-ui-preview">
      <p className="px-3 py-1 text-[11px] text-on-surface-variant border-b border-outline-variant/30">Building “{title}”…</p>
      <InlineUiFrame
        title={title}
        html={initial.html}
        css={initial.css}
        js=""
        mode="static"
        preview
        update={update}
        height={clampInlineUiHeight(measured ?? height, typeof window !== 'undefined' ? window.innerHeight : undefined)}
        onMessage={(m) => { if (m.type === 'height') setMeasured(m.height); }}
        onFlood={() => undefined}
      />
    </div>
  );
}
