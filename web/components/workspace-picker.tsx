'use client';

import { Briefcase, Check, ChevronDown, Plus, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useWorkspace } from '@/lib/workspace-context';

export function WorkspacePicker() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();
  const { workspaces, activeWorkspace, switchWorkspace, disabled, isLoading, createWorkspace } =
    useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [draftSlug, setDraftSlug] = useState('');
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
        setShowCreate(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (!isAuthenticated || disabled) return null;

  const label = isLoading
    ? 'Loading…'
    : activeWorkspace?.name ?? 'No workspace';

  const handleCreate = async () => {
    if (!draftSlug.trim() || !draftName.trim()) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      await createWorkspace({ slug: draftSlug.trim(), name: draftName.trim() });
      setShowCreate(false);
      setIsOpen(false);
      setDraftSlug('');
      setDraftName('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-low border border-outline-variant/10 rounded-full text-sm text-white hover:bg-[#1a1a1a] transition-colors cursor-pointer"
        aria-label="Switch workspace"
      >
        <Briefcase className="w-4 h-4 text-on-surface-variant" />
        <span className="font-medium max-w-[140px] truncate">{label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-on-surface-variant" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-72 bg-[#1a1a1a] rounded-2xl shadow-2xl ring-1 ring-outline-variant/20 z-50 overflow-hidden">
          {!showCreate ? (
            <>
              <div className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant px-3 pt-3 pb-1">
                Workspaces
              </div>
              <div className="max-h-72 overflow-y-auto">
                {workspaces.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-on-surface-variant text-center">
                    No workspaces yet
                  </div>
                ) : (
                  workspaces.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => {
                        switchWorkspace(w.id);
                        setIsOpen(false);
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[#20201f] cursor-pointer transition-colors text-left"
                    >
                      <Briefcase className="w-4 h-4 text-on-surface-variant shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-white truncate">{w.name}</p>
                        <p className="text-xs text-on-surface-variant truncate">/{w.slug}{w.isDefault ? ' · default' : ''}</p>
                      </div>
                      {w.id === activeWorkspace?.id && (
                        <Check className="w-4 h-4 text-primary shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-outline-variant/10 py-1">
                <button
                  onClick={() => setShowCreate(true)}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-on-surface-variant hover:text-white hover:bg-surface-container-high cursor-pointer transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Create workspace…
                </button>
                {user?.isAdmin && (
                  <button
                    onClick={() => {
                      router.push('/admin/orgs');
                      setIsOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-on-surface-variant hover:text-white hover:bg-surface-container-high cursor-pointer transition-colors"
                  >
                    <Users className="w-4 h-4" />
                    Manage orgs…
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="p-4 space-y-3">
              <div className="text-sm font-bold text-white">New workspace</div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
                  Slug
                </label>
                <input
                  type="text"
                  value={draftSlug}
                  onChange={(e) => setDraftSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="my-project"
                  className="w-full px-3 py-1.5 bg-surface-container-low border border-outline-variant/20 rounded-lg text-sm text-white placeholder-on-surface-variant focus:ring-1 focus:ring-primary/40 focus:border-primary/40"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
                  Name
                </label>
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="My Project"
                  className="w-full px-3 py-1.5 bg-surface-container-low border border-outline-variant/20 rounded-lg text-sm text-white placeholder-on-surface-variant focus:ring-1 focus:ring-primary/40 focus:border-primary/40"
                />
              </div>
              {createError && (
                <p className="text-xs text-error">{createError}</p>
              )}
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => { setShowCreate(false); setCreateError(null); }}
                  className="px-3 py-1.5 text-sm text-on-surface-variant hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={submitting || !draftSlug || !draftName}
                  className="px-3 py-1.5 text-sm bg-primary text-on-primary font-bold rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {submitting ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
