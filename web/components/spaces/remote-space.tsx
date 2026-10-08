'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FileText, Folder, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { type FilesSource, LEAVE_NOTICE, type RemoteFile, type RemoteSpace, remotePath, remoteSpacesKey } from '@/lib/remote-spaces';
import { useWorkspace } from '@/lib/workspace-context';

/** A read-only browser over a files source: folders, then one file at a time. */
export function FilesBrowser({ source }: { source: FilesSource }) {
  const [path, setPath] = useState('');
  const [open, setOpen] = useState<RemoteFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listing = useQuery({ queryKey: ['remote-files', source.key, path], queryFn: () => source.list(path) });
  const crumbs = path ? path.split('/') : [];
  const read = async (name: string) => {
    setError(null);
    try {
      setOpen(await source.read(path ? `${path}/${name}` : name));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="term-frame rounded-xs p-3 space-y-2 text-[12px]" data-testid="remote-files">
      <div className="flex items-center gap-1 text-on-surface-variant flex-wrap">
        <button type="button" onClick={() => { setPath(''); setOpen(null); }} className="hover:text-on-surface cursor-pointer">files</button>
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`} className="inline-flex items-center gap-1">
            <ChevronRight className="w-3 h-3" />
            <button type="button" onClick={() => { setPath(crumbs.slice(0, i + 1).join('/')); setOpen(null); }} className="hover:text-on-surface cursor-pointer">{c}</button>
          </span>
        ))}
      </div>
      {listing.isLoading && <p className="text-on-surface-variant">loading…</p>}
      {listing.error && <p role="alert" className="text-error">! {(listing.error as Error).message}</p>}
      {error && <p role="alert" className="text-error">! {error}</p>}
      <ul className="space-y-0.5">
        {(listing.data?.entries ?? []).map((e) => (
          <li key={e.name}>
            <button
              type="button"
              onClick={() => (e.type === 'dir' ? (setPath(path ? `${path}/${e.name}` : e.name), setOpen(null)) : void read(e.name))}
              className="flex items-center gap-1.5 w-full text-left px-1 py-0.5 rounded-xs hover:bg-surface-container-high cursor-pointer"
            >
              {e.type === 'dir' ? <Folder className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
              <span className="flex-1 truncate">{e.name}</span>
              {e.type === 'file' && <span className="text-[10px] text-on-surface-variant">{e.size} B</span>}
            </button>
          </li>
        ))}
        {listing.data && listing.data.entries.length === 0 && <li className="text-on-surface-variant">(empty)</li>}
      </ul>
      {open && (
        <div className="border-t border-outline-variant/40 pt-2 space-y-1">
          <p className="text-on-surface">{open.path}</p>
          {open.encoding === 'utf8'
            ? <pre className="whitespace-pre-wrap break-words text-[11px] max-h-96 overflow-y-auto">{open.content}</pre>
            : <p className="text-on-surface-variant">A binary file ({open.size} bytes): not shown here.</p>}
        </div>
      )}
    </div>
  );
}

/** Leave a space on another install, after the leave dialog. */
export function LeaveButton({ remote, onLeft }: { remote: Pick<RemoteSpace, 'id' | 'spaceName'>; onLeft?: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { refresh } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const leave = async () => {
    if (!confirm(`Leave ${remote.spaceName}? ${LEAVE_NOTICE}`)) return;
    try {
      const res = await api.delete<{ left: true; pending: boolean }>(remotePath(remote.id));
      await qc.invalidateQueries({ queryKey: remoteSpacesKey });
      await refresh();
      if (res.pending) setError('Left here; the host is not reachable now, so your install tells it the next time it connects.');
      if (onLeft) onLeft();
      else router.push('/');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => void leave()}
        data-testid="leave-remote-space"
        className="inline-flex items-center gap-1.5 px-2 py-1 text-[12px] rounded-xs border border-error/50 text-error hover:bg-error/10 cursor-pointer"
      >
        <LogOut className="w-3.5 h-3.5" /> leave this space
      </button>
      <p className="text-[11px] text-on-surface-variant">{LEAVE_NOTICE}</p>
      {error && <p role="alert" className="text-[11px] text-warning">{error}</p>}
    </div>
  );
}
