'use client';

import {
  AlertTriangle,
  FileText,
  FolderOpen,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

// In-chat file view (Thread 2): a lightweight reader/editor over the
// session file API. Text flips between read-only and an editable buffer;
// images render inline; directories are browsable. Edit-and-continue saves
// carry the loaded version so a concurrent change is rejected (409) loudly
// rather than silently clobbered. Deliberately NOT a full IDE — a textarea
// buffer keeps the bundle lean (no CodeMirror dep); syntax highlighting can
// layer on later without changing this contract.

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
}

function displayName(p: string): string {
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p;
}

export default function FileViewer({ sessionId, path: initialPath, onClose }: FileViewerProps) {
  const [path, setPath] = useState(initialPath);
  const [data, setData] = useState<FileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [version, setVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    setConflict(false);
    setEditing(false);
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

  useEffect(() => { load(path); }, [path, load]);

  // Esc closes the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
      // Reflect the saved content as the new baseline.
      setData((prev) => (prev && prev.type === 'text' ? { ...prev, content: draft, version: res.version, size: res.size } : prev));
    } catch (e) {
      const msg = (e as Error).message;
      // The 409 message from the server mentions the file changing.
      if (/changed since|no longer exists|reload before saving/i.test(msg)) setConflict(true);
      else setError(msg);
    } finally {
      setSaving(false);
    }
  }, [sessionId, path, draft, version]);

  const dirty = data?.type === 'text' && editing && draft !== data.content;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-outline-variant/30 bg-surface-container shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
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

          <div className="ml-auto flex items-center gap-1">
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
                  onClick={() => { setEditing(false); setDraft(data.content); setConflict(false); }}
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
              className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
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
        <div className="min-h-0 flex-1 overflow-auto">
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
            editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="h-[60vh] w-full resize-none bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-on-surface outline-none"
              />
            ) : (
              <pre className="m-0 overflow-auto bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-on-surface/90">
                <code>{data.content || '(empty file)'}</code>
              </pre>
            )
          )}

          {!loading && !error && data?.type === 'image' && (
            <div className="flex items-center justify-center bg-[#0d1117] p-4">
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
    </div>
  );
}
