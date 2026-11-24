'use client';

import { Folder, Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';

interface MoveProps {
  note: { id: string; title: string; slug: string };
  /** The folders notes are filed in now. */
  folders: string[];
  onClose: () => void;
  /** Resolves to an error message, or null once moved. */
  onMove: (folder: string, name: string) => Promise<string | null>;
}

/**
 * "Move to…": another folder (an existing one, or a new path) and, if
 * wanted, another name in it. The note's old address keeps working for
 * links (the server keeps it as an alias).
 */
export function MoveNoteDialog({ note, folders, onClose, onMove }: MoveProps) {
  const segs = note.slug.split('/');
  const [folder, setFolder] = useState(segs.slice(0, -1).join('/'));
  const [name, setName] = useState(segs[segs.length - 1] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function submit() {
    setBusy(true);
    setError(null);
    const err = await onMove(folder, name);
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <Modal open onClose={onClose} title={`Move “${note.title}”`}>
      <form className="notes-move" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="notes-move-list" role="listbox" aria-label="Folders">
          {['', ...folders].map((f) => (
            <button key={f || '/'} type="button" role="option" aria-selected={folder === f} onClick={() => setFolder(f)} className={cn('notes-move-folder')}>
              <Folder size={14} /> {f || 'Top level'}
            </button>
          ))}
        </div>
        <label className="notes-field" htmlFor={`${id}-folder`}>
          <span>Folder</span>
          <input id={`${id}-folder`} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Top level, or a new folder like projects/octipus" />
        </label>
        <label className="notes-field" htmlFor={`${id}-name`}>
          <span>Name</span>
          <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="notes-field-hint">Links to this note keep working after the move.</p>
        {error && <p role="alert" className="text-[13px] text-error">Could not move it: {error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="notes-text-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="notes-text-btn is-primary" disabled={busy || !name.trim()}>
            {busy && <Loader2 size={14} className="animate-spin" />} Move
          </button>
        </div>
      </form>
    </Modal>
  );
}
