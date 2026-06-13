'use client';

import { ArrowLeft, ArrowRight, Hash, Loader2, PanelRightClose, Plus, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LinkEdge, NoteDetail, Suggestion } from './types';

interface ContextProps {
  detail?: NoteDetail;
  suggestions: Suggestion[];
  suggestionsLoading: boolean;
  bodyHasLink: (title: string) => boolean;
  onOpenNote: (id: string) => void;
  onAddLink: (s: Suggestion) => void;
  onTagClick: (tag: string) => void;
  onCollapse: () => void;
}

function EdgeRow({ edge, dir, onOpenNote }: { edge: LinkEdge; dir: 'in' | 'out'; onOpenNote: (id: string) => void }) {
  const { endpoint } = edge;
  const title = endpoint.title ?? endpoint.ref ?? (endpoint.id ? `${endpoint.type}:${endpoint.id.slice(0, 8)}` : '—');
  const isGhost = !!endpoint.ref && !endpoint.id;
  const Icon = dir === 'in' ? ArrowLeft : ArrowRight;
  const clickable = endpoint.resolved && endpoint.type === 'note' && endpoint.id;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => clickable && endpoint.id && onOpenNote(endpoint.id)}
      title={endpoint.slug ?? endpoint.ref ?? undefined}
      className={cn(
        'w-full flex items-center gap-1.5 px-1.5 py-1 rounded-xs text-left text-[12px] transition-colors',
        clickable ? 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface' : 'text-on-surface-variant/50',
      )}
    >
      <Icon size={12} className="shrink-0 text-outline" />
      <span className="truncate flex-1">{title}</span>
      {edge.label && <span className="shrink-0 text-[10px] text-on-surface-variant/50 italic">{edge.label}</span>}
      {isGhost && <span className="shrink-0 text-[9px] text-outline uppercase">ghost</span>}
    </button>
  );
}

function Section({ icon, label, count, children }: { icon: React.ReactNode; label: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="section-label text-[10px] mb-1 flex items-center gap-1.5">
        {icon} {label}
        {count !== undefined && count > 0 && <span className="text-on-surface-variant/50">· {count}</span>}
      </h3>
      {children}
    </section>
  );
}

export function NoteContext({
  detail, suggestions, suggestionsLoading, bodyHasLink, onOpenNote, onAddLink, onTagClick, onCollapse,
}: ContextProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 h-11 shrink-0 border-b border-outline-variant/30">
        <span className="section-label text-[10px]">context</span>
        <button
          type="button"
          onClick={onCollapse}
          title="Hide context panel"
          className="p-1 rounded-xs hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface"
        >
          <PanelRightClose size={15} />
        </button>
      </div>

      {!detail ? (
        <div className="flex-1 grid place-items-center px-6 text-center">
          <p className="text-[12px] text-on-surface-variant/60">Open a note to see its connections.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-3 space-y-5 stagger">
          <Section icon={<ArrowLeft size={12} className="text-primary" />} label="backlinks" count={detail.backlinks.length}>
            {detail.backlinks.length === 0 ? (
              <p className="px-1.5 text-[12px] text-on-surface-variant/50">None yet.</p>
            ) : (
              <div>{detail.backlinks.map((e) => <EdgeRow key={e.id} edge={e} dir="in" onOpenNote={onOpenNote} />)}</div>
            )}
          </Section>

          <Section icon={<ArrowRight size={12} className="text-primary" />} label="outgoing" count={detail.outgoing.length}>
            {detail.outgoing.length === 0 ? (
              <p className="px-1.5 text-[12px] text-on-surface-variant/50">No links out. Use [[ to link.</p>
            ) : (
              <div>{detail.outgoing.map((e) => <EdgeRow key={e.id} edge={e} dir="out" onOpenNote={onOpenNote} />)}</div>
            )}
          </Section>

          <Section icon={<Sparkles size={12} className="text-accent" />} label="suggested">
            {suggestionsLoading && <Loader2 className="animate-spin mx-1.5 text-on-surface-variant" size={13} />}
            {!suggestionsLoading && suggestions.length === 0 && (
              <p className="px-1.5 text-[12px] text-on-surface-variant/50">No suggestions.</p>
            )}
            <ul>
              {suggestions.map((s) => {
                const linked = bodyHasLink(s.title ?? s.id);
                return (
                  <li key={s.id} className="group flex items-center gap-1.5 px-1.5 py-1 rounded-xs hover:bg-surface-container-high">
                    <button
                      type="button"
                      disabled={linked}
                      onClick={() => onAddLink(s)}
                      title={linked ? 'Already linked' : 'Add as a [[link]]'}
                      className="shrink-0 p-0.5 rounded text-accent hover:bg-surface-container-highest disabled:opacity-30"
                    >
                      <Plus size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => s.type === 'note' && onOpenNote(s.id)}
                      className="truncate flex-1 text-left text-[12px] text-on-surface-variant hover:text-on-surface"
                    >
                      {s.title ?? s.id.slice(0, 8)}
                    </button>
                    <span className="shrink-0 text-[10px] text-on-surface-variant/50 tabular-nums">{(s.similarity * 100).toFixed(0)}%</span>
                  </li>
                );
              })}
            </ul>
          </Section>

          {detail.tags.length > 0 && (
            <Section icon={<Hash size={12} className="text-primary" />} label="tags">
              <div className="flex flex-wrap gap-1 px-1">
                {detail.tags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onTagClick(t)}
                    className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant hover:text-primary"
                  >
                    <Hash size={9} />{t}
                  </button>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
