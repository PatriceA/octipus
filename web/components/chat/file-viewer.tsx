'use client';

import {
  AlertTriangle,
  FileDiff,
  FileText,
  FolderOpen,
  Loader2,
  Paperclip,
  Pencil,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { computeLineDiff } from '../../../src/shared/diff';
import CodeEditor from '@/components/chat/code-editor';
import DiffView from '@/components/chat/diff-view';
import { api } from '@/lib/api';

// In-chat file view (Threads 2–3): a lightweight reader/editor over the
// session file API. Text flips between read-only and an editable CodeMirror
// buffer; while editing, a Diff toggle shows unsaved changes against the loaded
// baseline; images render inline; directories are browsable. Edit-and-continue
// saves carry the loaded version so a concurrent change is rejected (409)
// loudly rather than silently clobbered. Deliberately NOT a full IDE.

type FileResponse =
  | { type: 'directory'; path: string; entries: Array<{ name: string; path: string; isDirectory: boolean; size?: number }> }
  | { type: 'text'; path: string; content: string; version: string; size: number; modifiedAt: string }
  | { type: 'image'; path: string; dataUrl: string; mimeType: string; version: string; size: number; modifiedAt: string }
  | { type: 'binary'; path: string; version: string; size: number; modifiedAt: string }
  | { type: 'too-large'; path: string; size: number };

interface FileViewerProps {
  sessionId: string;
  /** Initial path to open (relative to the workspace root or an absolute path). */
  path: string;
  onClose: () => void;
  /**
   * Attach this file (at its current version) to the next chat message —
   * edit-and-continue. The agent's next turn re-reads the file and sees the
   * live contents, so "make it rhyme" operates on the user's edits, not a
   * stale transcript copy.
   */
  onAttach?: (ref: { path: string; version: string }) => void;
  /**
   * Bumped whenever the agent writes the open file (e.g. a count of file-change
   * events for this path) so the panel can live-refresh to show the agent's
   * work. Ignored while the user is mid-edit so a reload can't clobber a draft.
   */
  reloadSignal?: number;
}

function displayName(p: string): string {
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p;
}

export default function FileViewer({ sessionId, path: initialPath, onClose, onAttach, reloadSignal = 0 }: FileViewerProps) {
  const [path, setPath] = useState(initialPath);
  const [data, setData] = useState<FileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [version, setVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  // While editing: show a diff of unsaved changes vs the loaded baseline.
  const [showDiff, setShowDiff] = useState(false);
  // Brief flash after the agent writes the open file (live-work indicator).
  const [justUpdated, setJustUpdated] = useState(false);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    setConflict(false);
    setEditing(false);
    setShowDiff(false);
    try {
      const res = await api.get<FileResponse>(`/sessions/${sessionId}/files?path=${encodeURIComponent(p)}`);
      setData(res);
      if (res.type === 'text') {
        setDraft(res.content);
        setVersion(res.version);
      } else if ('version' in res) {
        setVersion(res.version);
      }
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Fetch-on-open: loading a new path is a legit external sync, not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(path); }, [path, load]);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Live work: when the agent writes the open file (reloadSignal bumps), refresh
  // to show it — unless the user is mid-edit, where a reload would clobber their
  // draft. Briefly flashes an "updated" badge. The initial signal is skipped.
  const prevSignal = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === prevSignal.current) return;
    prevSignal.current = reloadSignal;
    if (editing) return; // don't stomp an in-progress edit
    /* eslint-disable react-hooks/set-state-in-effect -- reacting to an external agent-write signal; the refresh is a deliberate sync, not a render loop */
    load(path);
    setJustUpdated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    const t = setTimeout(() => setJustUpdated(false), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to new agent-write signals
  }, [reloadSignal]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const res = await api.put<{ path: string; version: string; size: number; modifiedAt: string }>(
        `/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`,
        { content: draft, baseVersion: version ?? undefined },
      );
      setVersion(res.version);
      setEditing(false);
      setShowDiff(false);
      // Reflect the saved content as the new baseline.
      setData((prev) => (prev && prev.type === 'text' ? { ...prev, content: draft, version: res.version, size: res.size } : prev));
      // Edit-and-continue: a save is the strongest "operate on this next" signal,
      // so auto-attach the freshly-saved version to the next chat turn.
      onAttach?.({ path, version: res.version });
    } catch (e) {
      const msg = (e as Error).message;
      // The 409 message from the server mentions the file changing.
      if (/changed since|no longer exists|reload before saving/i.test(msg)) setConflict(true);
      else setError(msg);
    } finally {
      setSaving(false);
    }
  }, [sessionId, path, draft, version, onAttach]);

  // Attach the current file (without editing) to the next chat turn, then close.
  const attach = useCallback(() => {
    if (version) onAttach?.({ path, version });
    onClose();
  }, [onAttach, path, version, onClose]);

  const dirty = data?.type === 'text' && editing && draft !== data.content;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-container">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-outline-variant/20 px-3 py-2">
          {data?.type === 'directory' ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-primary" />
          )}
          <span className="truncate font-mono text-sm text-on-surface" title={path}>
            {displayName(path)}
          </span>
          {dirty && <span className="text-[10px] text-warning">● unsaved</span>}
          {justUpdated && !editing && (
            <span className="flex items-center gap-1 text-[10px] text-primary" aria-live="polite">
              <span className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" /> updated
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {onAttach && data && data.type !== 'directory' && version && !editing && (
              <button
                type="button"
                onClick={attach}
                title="Attach to chat — the agent's next reply will see this file's current contents"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              >
                <Paperclip className="h-3.5 w-3.5" /> Attach to chat
              </button>
            )}
            {data?.type === 'text' && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            )}
            {data?.type === 'text' && editing && (
              <>
                <button
                  type="button"
                  onClick={() => setShowDiff((v) => !v)}
                  disabled={!dirty}
                  title={dirty ? 'Toggle a diff of your unsaved changes' : 'No unsaved changes to diff'}
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-40 ${showDiff ? 'bg-surface-container-high text-on-surface' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}`}
                >
                  <FileDiff className="h-3.5 w-3.5" /> {showDiff ? 'Editor' : 'Diff'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setShowDiff(false); setDraft(data.content); setConflict(false); }}
                  className="rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !dirty}
                  className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => load(path)}
              title="Reload"
              aria-label="Reload file"
              className="cursor-pointer rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close panel"
              aria-label="Close file panel"
              className="cursor-pointer rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Conflict banner */}
        {conflict && (
          <div className="flex items-center gap-2 border-b border-warning/30 bg-warning-container/20 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>This file changed since you opened it. Reload to get the latest, then re-apply your edit.</span>
            <button type="button" onClick={() => load(path)} className="ml-auto underline hover:opacity-80">
              Reload
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-on-surface-variant">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-center gap-2 px-4 py-8 text-sm text-error">
              <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {!loading && !error && data?.type === 'text' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {editing && showDiff ? (
                <DiffView patch={computeLineDiff(data.content, draft).patch} className="min-h-0 flex-1 p-2" />
              ) : (
                <CodeEditor
                  value={editing ? draft : data.content}
                  onChange={editing ? setDraft : undefined}
                  editable={editing}
                  filename={path}
                  height="100%"
                />
              )}
            </div>
          )}

          {!loading && !error && data?.type === 'image' && (
            <div className="flex items-center justify-center bg-[#0d1117] p-4">
              {/* Source is an in-memory data: URL from the session file API, not a
                  remote asset — next/image would force `unoptimized` and add no value. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={data.dataUrl} alt={displayName(path)} className="max-h-[60vh] object-contain" />
            </div>
          )}

          {!loading && !error && data?.type === 'directory' && (
            <ul className="divide-y divide-outline-variant/10 py-1">
              {data.entries.length === 0 && (
                <li className="px-4 py-3 text-xs italic text-on-surface-variant">empty directory</li>
              )}
              {data.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => setPath(entry.path)}
                    className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs hover:bg-surface-container-high"
                  >
                    {entry.isDirectory ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
                    )}
                    <span className="truncate font-mono">{entry.name}{entry.isDirectory ? '/' : ''}</span>
                    {entry.size != null && (
                      <span className="ml-auto text-on-surface-variant/60">{entry.size}B</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!loading && !error && (data?.type === 'binary' || data?.type === 'too-large') && (
            <div className="flex flex-col items-center gap-1 px-4 py-12 text-center text-sm text-on-surface-variant">
              <AlertTriangle className="h-5 w-5 opacity-60" />
              {data.type === 'binary'
                ? 'Binary file — no preview available.'
                : `File too large to preview (${Math.round((data.size / 1024 / 1024) * 10) / 10} MB).`}
            </div>
          )}
        </div>
    </div>
  );
}
