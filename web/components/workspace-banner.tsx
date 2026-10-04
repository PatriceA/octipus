'use client';

import { Archive, Eye, X } from 'lucide-react';
import Link from 'next/link';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * Banners about the selected workspace, above every page:
 *
 * - the notice that a space went away under the user (they were removed; the
 *   workspace context switched back to the default workspace);
 * - an archived space: read-only for everyone until an owner unarchives it;
 * - a role that cannot write (commenter, viewer, guest), so the missing
 *   create and edit controls do not look like a bug.
 */
export function WorkspaceBanner() {
  const { activeWorkspace, access, notice, dismissNotice } = useWorkspace();
  const space = activeWorkspace?.kind === 'shared' ? activeWorkspace : null;

  return (
    <>
      {notice && (
        <div
          role="alert"
          data-testid="workspace-notice"
          className="flex items-center gap-2 px-4 py-2 text-[12px] font-mono border-b border-warning/30 bg-warning/10 text-on-surface"
        >
          <span className="text-warning font-bold">!</span>
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={dismissNotice} aria-label="Dismiss" className="text-on-surface-variant hover:text-on-surface cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {space && access.archived && (
        <div
          role="status"
          data-testid="archived-banner"
          className="flex items-center gap-2 px-4 py-2 text-[12px] font-mono border-b border-outline-variant/40 bg-surface-container-low text-on-surface-variant"
        >
          <Archive className="w-3.5 h-3.5" />
          <span className="flex-1">
            <span className="text-on-surface">{space.name}</span> is archived — everything in it is read-only.
          </span>
          {space.role === 'owner' && (
            <Link href={`/spaces/${space.id}/settings`} className="underline hover:text-on-surface">
              unarchive in settings
            </Link>
          )}
        </div>
      )}
      {space && !access.archived && !access.canWrite && (
        <div
          role="status"
          data-testid="read-only-banner"
          className="flex items-center gap-2 px-4 py-1.5 text-[12px] font-mono border-b border-outline-variant/40 bg-surface-container-low text-on-surface-variant"
        >
          <Eye className="w-3.5 h-3.5" />
          <span>
            you are a <span className="text-on-surface">{space.role}</span> in {space.name}:{' '}
            {access.canComment ? 'you can read and comment' : 'you can read'}, not edit.
          </span>
        </div>
      )}
    </>
  );
}
