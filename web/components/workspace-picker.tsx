'use client';

import { Archive, Briefcase, Check, ChevronDown, Plus, Send, Settings, Users, UsersRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { type SpaceRole, useWorkspace } from '@/lib/workspace-context';

/** A member's role in a space, as a small badge (owner stands out). */
export function RoleBadge({ role }: { role: SpaceRole }) {
  return (
    <span
      data-testid="role-badge"
      className={cn(
        'px-1 py-px rounded-xs border text-[10px] leading-none lowercase shrink-0',
        role === 'owner' ? 'border-primary/50 text-primary' : 'border-outline-variant/60 text-on-surface-variant',
      )}
    >
      {role}
    </span>
  );
}

export function WorkspacePicker() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();
  const { workspaces, spaces, activeWorkspace, switchWorkspace, disabled, isLoading, createWorkspace, createSpace, refresh } =
    useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  // "New shared space": just a name; the creator becomes its owner.
  const [showCreateSpace, setShowCreateSpace] = useState(false);
  const [draftSpaceName, setDraftSpaceName] = useState('');
  const [draftSlug, setDraftSlug] = useState('');
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Transfer-ownership state: which workspace is being transferred, who
  // it goes to, and the last error if any.
  const [transferTarget, setTransferTarget] = useState<{ id: string; slug: string; name: string } | null>(null);
  const [transferUsername, setTransferUsername] = useState('');
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
        setShowCreate(false);
        setShowCreateSpace(false);
        setTransferTarget(null);
        setTransferError(null);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleTransfer = async () => {
    if (!transferTarget || !transferUsername.trim()) return;
    setTransferring(true);
    setTransferError(null);
    try {
      await api.post(`/me/workspaces/${transferTarget.id}/transfer`, {
        recipientUsername: transferUsername.trim(),
      });
      await refresh();
      setTransferTarget(null);
      setTransferUsername('');
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : 'Transfer failed');
    } finally {
      setTransferring(false);
    }
  };

  if (!isAuthenticated || disabled) return null;

  // For the default workspace show the slug — it corresponds to the main
  // workspace path and is more informative than the generic "Default"
  // label. Non-default workspaces show their friendly name.
  const label = isLoading
    ? 'Loading…'
    : activeWorkspace
      ? activeWorkspace.kind === 'personal' && activeWorkspace.isDefault
        ? activeWorkspace.slug
        : activeWorkspace.name
      : 'No workspace';

  const handleCreateSpace = async () => {
    if (!draftSpaceName.trim()) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      await createSpace(draftSpaceName.trim());
      setShowCreateSpace(false);
      setIsOpen(false);
      setDraftSpaceName('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  };

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
    <div className="relative font-mono" ref={ref}>
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[12px] text-on-surface hover:bg-surface-container hover:border-outline transition-colors cursor-pointer"
        aria-label="Switch workspace"
      >
        {activeWorkspace?.kind === 'shared'
          ? <UsersRound className="w-3.5 h-3.5 text-on-surface-variant" />
          : <Briefcase className="w-3.5 h-3.5 text-on-surface-variant" />}
        <span className="max-w-[140px] truncate">{label}</span>
        {activeWorkspace?.kind === 'shared' && <RoleBadge role={activeWorkspace.role} />}
        <ChevronDown className="w-3 h-3 text-outline-variant" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-1 w-72 bg-surface-container border border-outline-variant rounded-xs shadow-xl z-50 overflow-hidden">
          {transferTarget ? (
            <div className="p-3 space-y-2.5">
              <div className="text-[12px] text-on-surface flex items-center gap-1.5">
                <span className="text-primary font-bold">&gt;</span> transfer workspace
              </div>
              <p className="text-[11px] text-on-surface-variant leading-snug">
                hand <span className="text-primary">{transferTarget.slug}</span> to another
                user. sessions / documents / hooks / workspace-scoped secrets move with it.
              </p>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-outline-variant">
                  recipient username
                </label>
                <input
                  type="text"
                  value={transferUsername}
                  onChange={(e) => setTransferUsername(e.target.value)}
                  placeholder="alice"
                  autoFocus
                  className="w-full px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary"
                />
              </div>
              {transferError && <p className="text-[11px] text-error">! {transferError}</p>}
              <div className="flex items-center gap-2 justify-end pt-1">
                <button
                  onClick={() => { setTransferTarget(null); setTransferError(null); setTransferUsername(''); }}
                  className="px-2 py-1 text-[12px] text-on-surface-variant hover:text-on-surface cursor-pointer"
                >
                  cancel
                </button>
                <button
                  onClick={handleTransfer}
                  disabled={transferring || !transferUsername.trim()}
                  className="px-2.5 py-1 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {transferring ? 'transferring…' : '❯ transfer'}
                </button>
              </div>
            </div>
          ) : showCreateSpace ? (
            <div className="p-3 space-y-2.5">
              <div className="text-[12px] text-on-surface flex items-center gap-1.5">
                <span className="text-primary font-bold">&gt;</span> new shared space
              </div>
              <p className="text-[11px] text-on-surface-variant leading-snug">
                notes, tasks, documents and files shared with the people you invite. you are its owner.
              </p>
              <div className="space-y-1">
                <label htmlFor="new-space-name" className="text-[10px] uppercase tracking-wider text-outline-variant">name</label>
                <input
                  id="new-space-name"
                  type="text"
                  value={draftSpaceName}
                  onChange={(e) => setDraftSpaceName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateSpace()}
                  placeholder="Launch"
                  maxLength={120}
                  autoFocus
                  className="w-full px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary"
                />
              </div>
              {createError && <p className="text-[11px] text-error">! {createError}</p>}
              <div className="flex items-center gap-2 justify-end pt-1">
                <button
                  onClick={() => { setShowCreateSpace(false); setCreateError(null); }}
                  className="px-2 py-1 text-[12px] text-on-surface-variant hover:text-on-surface cursor-pointer"
                >
                  cancel
                </button>
                <button
                  onClick={handleCreateSpace}
                  disabled={submitting || !draftSpaceName.trim()}
                  className="px-2.5 py-1 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {submitting ? 'creating…' : '❯ create space'}
                </button>
              </div>
            </div>
          ) : !showCreate ? (
            <>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-outline-variant px-3 pt-2 pb-1 border-b border-outline-variant/40 bg-surface-container-low">
                <span className="text-primary/70">{"// "}</span><span>my workspaces</span>
                <span className="ml-auto normal-case text-outline-variant">{workspaces.length}</span>
              </div>
              <div className="text-[10px] text-outline px-3 py-1.5 leading-snug">
                org-level data scope. filesystem folders live in settings → integrations.
              </div>
              <div className="max-h-72 overflow-y-auto">
                {workspaces.length === 0 ? (
                  <div className="px-3 py-5 text-[12px] text-on-surface-variant text-center">
                    -- no workspaces --
                  </div>
                ) : (
                  workspaces.map((w) => {
                    const isActive = w.id === activeWorkspace?.id;
                    return (
                      <div
                        key={w.id}
                        className={cn(
                          'group w-full flex items-center gap-2 pl-2 pr-2 py-1.5 border-l-2 border-transparent hover:bg-surface-container-high hover:border-primary transition-colors',
                          isActive && 'border-primary bg-primary-container/30'
                        )}
                      >
                        <button
                          onClick={() => { switchWorkspace(w.id); setIsOpen(false); }}
                          className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer text-left"
                        >
                          <span aria-hidden className={cn('w-3 text-center text-primary', isActive ? 'opacity-100' : 'opacity-0')}>
                            ❯
                          </span>
                          <Briefcase className="w-3.5 h-3.5 text-on-surface-variant shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] text-on-surface truncate">{w.name}</p>
                            <p className="text-[11px] text-on-surface-variant truncate">
                              {w.slug}
                              {w.isDefault && <span className="ml-1.5 text-outline-variant">[default]</span>}
                            </p>
                          </div>
                          {isActive && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTransferTarget({ id: w.id, slug: w.slug, name: w.name });
                            setTransferError(null);
                            setTransferUsername('');
                          }}
                          title="Transfer ownership"
                          className="p-1 rounded-xs text-outline-variant hover:text-primary opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity"
                        >
                          <Send className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              {/* Shared spaces: no transfer (a space has owners, not one
                  owner); each row's gear opens the space's settings. */}
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-outline-variant px-3 pt-2 pb-1 border-y border-outline-variant/40 bg-surface-container-low">
                <span className="text-primary/70">{"// "}</span><span>shared spaces</span>
                <span className="ml-auto normal-case text-outline-variant">{spaces.length}</span>
              </div>
              <div className="max-h-72 overflow-y-auto" data-testid="shared-spaces">
                {spaces.length === 0 ? (
                  <div className="px-3 py-3 text-[12px] text-on-surface-variant text-center">
                    -- no shared spaces --
                  </div>
                ) : (
                  spaces.map((sp) => {
                    const isActive = sp.id === activeWorkspace?.id;
                    return (
                      <div
                        key={sp.id}
                        className={cn(
                          'group w-full flex items-center gap-2 pl-2 pr-2 py-1.5 border-l-2 border-transparent hover:bg-surface-container-high hover:border-primary transition-colors',
                          isActive && 'border-primary bg-primary-container/30'
                        )}
                      >
                        <button
                          onClick={() => { switchWorkspace(sp.id); setIsOpen(false); }}
                          className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer text-left"
                        >
                          <span aria-hidden className={cn('w-3 text-center text-primary', isActive ? 'opacity-100' : 'opacity-0')}>
                            ❯
                          </span>
                          <UsersRound className="w-3.5 h-3.5 text-on-surface-variant shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] text-on-surface truncate">{sp.name}</p>
                            <p className="text-[11px] text-on-surface-variant truncate flex items-center gap-1">
                              {sp.memberCount} {sp.memberCount === 1 ? 'member' : 'members'}
                              {sp.archivedAt && (
                                <span className="inline-flex items-center gap-0.5 text-outline-variant">
                                  <Archive className="w-2.5 h-2.5" /> archived
                                </span>
                              )}
                            </p>
                          </div>
                          <RoleBadge role={sp.role} />
                          {isActive && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => { router.push(`/spaces/${sp.id}/settings`); setIsOpen(false); }}
                          title="Space settings"
                          aria-label={`Settings for ${sp.name}`}
                          className="p-1 rounded-xs text-outline-variant hover:text-primary opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer transition-opacity"
                        >
                          <Settings className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="border-t border-outline-variant/40 py-0.5">
                <button
                  onClick={() => { setShowCreateSpace(true); setCreateError(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer transition-colors"
                >
                  <UsersRound className="w-3.5 h-3.5" />
                  new shared space…
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  create workspace…
                </button>
                {user?.isAdmin && (
                  <button
                    onClick={() => { router.push('/admin/orgs'); setIsOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer transition-colors"
                  >
                    <Users className="w-3.5 h-3.5" />
                    manage orgs…
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="p-3 space-y-2.5">
              <div className="text-[12px] text-on-surface flex items-center gap-1.5">
                <span className="text-primary font-bold">&gt;</span> new workspace
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-outline-variant">slug</label>
                <input
                  type="text"
                  value={draftSlug}
                  onChange={(e) => setDraftSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="my-project"
                  className="w-full px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-outline-variant">name</label>
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="My Project"
                  className="w-full px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary"
                />
              </div>
              {createError && <p className="text-[11px] text-error">! {createError}</p>}
              <div className="flex items-center gap-2 justify-end pt-1">
                <button
                  onClick={() => { setShowCreate(false); setCreateError(null); }}
                  className="px-2 py-1 text-[12px] text-on-surface-variant hover:text-on-surface cursor-pointer"
                >
                  cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={submitting || !draftSlug || !draftName}
                  className="px-2.5 py-1 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {submitting ? 'creating…' : '❯ create'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
