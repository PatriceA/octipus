'use client';

import { FolderInput, Hash, MoreHorizontal, Star, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { TagCount } from './types';

const KINDS: Array<{ value: string; label: string }> = [
  { value: 'note', label: 'Note' },
  { value: 'daily', label: 'Daily note' },
  { value: 'moc', label: 'Map of content' },
  { value: 'literature', label: 'Literature note' },
];

interface DetailsProps {
  isNew: boolean;
  /** The title set by hand ('' when it comes from the first line). */
  title: string;
  titlePlaceholder: string;
  setTitle: (title: string) => void;
  tags: string[];
  setTags: (tags: string[]) => void;
  tagSuggestions: TagCount[];
  kind: string;
  setKind: (kind: string) => void;
  /** A new note's folder (an existing note moves with `onMove`). */
  folder: string;
  setFolder: (folder: string) => void;
  slug?: string;
  noteDate?: string | null;
  pinned: boolean;
  onTogglePin: () => void;
  onMove?: () => void;
  onTitleEditing?: (editing: boolean) => void;
}

/** Normalize a typed tag the way the server stores `#tags`. */
export function cleanTag(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9/_-]/g, '');
}

/**
 * The note's details, out of the way of the text: its title (when it is not
 * the first line's), tags, kind, folder or location, and pin. Opened from
 * the "…" button in the note's bar.
 */
export function NoteDetailsMenu(props: DetailsProps) {
  const { isNew, kind, setKind, tags, setTags } = props;
  const [open, setOpen] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const kinds = KINDS.some((k) => k.value === kind) ? KINDS : [...KINDS, { value: kind, label: kind }];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function addTag(raw: string) {
    const t = cleanTag(raw);
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Details"
        aria-label="Details"
        className={cn('notes-icon-btn', open && 'is-on')}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div role="dialog" aria-label="Note details" className="notes-popover notes-details">
          <label className="notes-field" htmlFor={`${id}-title`}>
            <span>Title</span>
            <input
              id={`${id}-title`}
              value={props.title}
              placeholder={props.titlePlaceholder}
              onChange={(e) => props.setTitle(e.target.value)}
              onFocus={() => props.onTitleEditing?.(true)}
              onBlur={() => props.onTitleEditing?.(false)}
            />
          </label>
          <p className="notes-field-hint">Leave empty to use the first line. Renaming keeps links to the note working.</p>

          <div className="notes-field">
            <span>Tags</span>
            <div className="notes-tag-input">
              {tags.map((t) => (
                <span key={t} className="notes-tag-chip">
                  <Hash size={10} />{t}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}><X size={10} /></button>
                </span>
              ))}
              <input
                value={tagInput}
                aria-label="Add a tag"
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); }
                  if (e.key === 'Backspace' && !tagInput && tags.length) setTags(tags.slice(0, -1));
                }}
                onBlur={() => tagInput && addTag(tagInput)}
                list={`${id}-tags`}
                placeholder={tags.length ? '' : 'Add a tag'}
              />
              <datalist id={`${id}-tags`}>
                {props.tagSuggestions.map((t) => <option key={t.tag} value={t.tag} />)}
              </datalist>
            </div>
          </div>

          <label className="notes-field" htmlFor={`${id}-kind`}>
            <span>Kind</span>
            <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>

          {isNew ? (
            <label className="notes-field" htmlFor={`${id}-folder`}>
              <span>Folder</span>
              <input id={`${id}-folder`} value={props.folder} onChange={(e) => props.setFolder(e.target.value)} placeholder="e.g. projects/octipus" />
            </label>
          ) : (
            <div className="notes-field">
              <span>Location</span>
              <div className="flex items-center gap-2 min-w-0">
                <code className="notes-slug" title={props.slug}>{props.slug}</code>
                {props.onMove && (
                  <button type="button" className="notes-text-btn" onClick={() => { setOpen(false); props.onMove?.(); }}>
                    <FolderInput size={14} /> Move to…
                  </button>
                )}
              </div>
            </div>
          )}
          {props.noteDate && <p className="notes-field-hint">Day: {props.noteDate}</p>}

          {!isNew && (
            <button type="button" className={cn('notes-menu-item', props.pinned && 'is-on')} onClick={props.onTogglePin} aria-pressed={props.pinned}>
              <Star size={15} className={props.pinned ? 'fill-current' : ''} /> {props.pinned ? 'Pinned to the top' : 'Pin to the top'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
