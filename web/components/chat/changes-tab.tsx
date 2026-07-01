'use client';

/**
 * Changes tab — a git-backed review of what the agent changed in this
 * session's workspace. Mirrors OpenHands' "Changes" tab: the server returns a
 * list of changed paths and, per file, the `{ original, modified }` text pair;
 * we compute the visual diff client-side with `computeLineDiff` and render it
 * with the shared `DiffView`.
 *
 * Backed by `GET /sessions/:id/changes` and `/changes/diff`. Gracefully shows a
 * "not a git repository" state when the workspace isn't a repo (the common case
 * for a scratch workspace), so it never lies about having captured changes.
 */
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { computeLineDiff } from '../../../src/shared/diff';
import type {
  SessionChange,
  SessionChangeDiff,
  SessionChangesResult,
  SessionChangeStatus,
} from '../../../src/shared/session-changes';
import { api } from '@/lib/api';
import DiffView from './diff-view';

const STATUS_LABEL: Record<SessionChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};

const STATUS_COLOR: Record<SessionChangeStatus, string> = {
  added: 'text-tertiary',
  modified: 'text-primary',
  deleted: 'text-error',
  renamed: 'text-primary',
  untracked: 'text-outline',
};

export default function ChangesTab({ sessionId }: { sessionId: string | null }) {
  const [result, setResult] = useState<SessionChangesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, SessionChangeDiff | 'loading' | 'error'>>({});

  const loadList = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<SessionChangesResult>(`/sessions/${sessionId}/changes`);
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Fetch when the tab first mounts (it only mounts when the section is opened).
  useEffect(() => {
    void loadList();
  }, [loadList]);

  const toggleFile = useCallback(
    async (change: SessionChange) => {
      if (expanded === change.path) {
        setExpanded(null);
        return;
      }
      setExpanded(change.path);
      if (diffs[change.path] && diffs[change.path] !== 'error') return;
      setDiffs((prev) => ({ ...prev, [change.path]: 'loading' }));
      try {
        const diff = await api.get<SessionChangeDiff>(
          `/sessions/${sessionId}/changes/diff?path=${encodeURIComponent(change.path)}`,
        );
        setDiffs((prev) => ({ ...prev, [change.path]: diff }));
      } catch (e) {
        console.error(`changes-tab: failed to load diff for ${change.path}`, e);
        setDiffs((prev) => ({ ...prev, [change.path]: 'error' }));
      }
    },
    [expanded, diffs, sessionId],
  );

  if (!sessionId) {
    return <p className="text-[10px] italic text-outline">no active session.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-outline">
          {result?.branch ? `branch ${result.branch}` : 'workspace changes'}
        </span>
        <button
          type="button"
          onClick={() => void loadList()}
          disabled={loading}
          title="Refresh changes"
          className="flex items-center gap-1 rounded-xs px-1 py-0.5 text-[10px] text-on-surface-variant hover:bg-surface-container hover:text-on-surface disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error ? (
        <p className="text-[10px] italic text-error">{error}</p>
      ) : loading && !result ? (
        <p className="text-[10px] italic text-outline">loading…</p>
      ) : result && !result.isGitRepo ? (
        <p className="text-[10px] italic text-outline">not a git repository — no changes to show.</p>
      ) : result && result.changes.length === 0 ? (
        <p className="text-[10px] italic text-outline">no changes in the workspace.</p>
      ) : (
        <ul className="space-y-1">
          {result?.changes.map((change) => {
            const name = change.path.replace(/\\/g, '/').split('/').pop() || change.path;
            const entry = diffs[change.path];
            const isOpen = expanded === change.path;
            return (
              <li key={change.path} className="rounded-xs border border-outline-variant/20">
                <button
                  type="button"
                  onClick={() => void toggleFile(change)}
                  title={change.path}
                  className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-[11px] text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
                >
                  <span className={`w-3 shrink-0 text-center font-bold ${STATUS_COLOR[change.status]}`}>
                    {STATUS_LABEL[change.status]}
                  </span>
                  <span className="truncate font-mono">{name}</span>
                </button>
                {isOpen && (
                  <div className="border-t border-outline-variant/20 p-1.5">
                    {entry === 'loading' || entry === undefined ? (
                      <p className="text-[10px] italic text-outline">loading diff…</p>
                    ) : entry === 'error' ? (
                      <p className="text-[10px] italic text-error">failed to load diff.</p>
                    ) : (
                      <>
                        <DiffView
                          patch={computeLineDiff(entry.original, entry.modified).patch}
                          className="text-[10px]"
                        />
                        {entry.truncated && (
                          <p className="mt-1 text-[9px] italic text-outline">file truncated before diff.</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
