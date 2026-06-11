'use client';

import { Check, ChevronDown, Code2, FolderOpen, GitBranch, Loader2, MessageSquare, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface NewSessionOptions {
  devMode: boolean;
  projectPath?: string;
  projectName?: string;
}

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (opts: NewSessionOptions) => void;
}

interface ProjectEntry {
  name: string;
  path: string;
  hasGit: boolean;
  hasSummary: boolean;
}

export function NewSessionDialog({ open, onClose, onCreate }: NewSessionDialogProps) {
  const [devMode, setDevMode] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // Create repository state
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState('');
  // Where the new repo lands. Candidates are the workspace root + each
  // configured additional path; default is the root. Surfaced so the user
  // isn't left guessing where "Create new repository" puts the folder.
  const [parentFolders, setParentFolders] = useState<{ name: string; path: string }[]>([]);
  const [repoParent, setRepoParent] = useState('');
  const [initGit, setInitGit] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createSuccess, setCreateSuccess] = useState('');
  const repoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && devMode) {
      loadProjects();
    }
  }, [open, devMode]);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const ws = await api.get<{ rootPath: string; additionalPaths: string[] }>('/workspace');
      if (ws?.rootPath) {
        // Parent-folder candidates for new repos: the root + each additional path.
        const parents = [
          { name: 'Workspace root', path: ws.rootPath },
          ...(ws.additionalPaths || []).map((p) => ({ name: p.split('/').pop() || p, path: p })),
        ];
        setParentFolders(parents);
        setRepoParent((cur) => cur || ws.rootPath);

        const dirs: ProjectEntry[] = [];

        const listChildren = async (basePath: string) => {
          try {
            const result = await api.post<{ result: { entries: Array<{ name: string; isDirectory: boolean }> } }>(
              '/tools/filesystem/tools/list_directory/execute',
              { args: { path: basePath, recursive: false } },
            );
            const entries = result?.result?.entries || [];
            for (const e of entries) {
              if (!e.isDirectory || e.name.startsWith('.')) continue;
              const childPath = `${basePath}/${e.name}`.replace(/\\/g, '/');
              if (dirs.find(d => d.path === childPath)) continue;
              dirs.push({ name: e.name, path: childPath, hasGit: false, hasSummary: false });
            }
          } catch {}
        };

        await listChildren(ws.rootPath);
        // Each additional path is a *parent* folder (e.g. ~/Github Reps);
        // surface its repo children rather than the path itself.
        for (const p of ws.additionalPaths || []) {
          await listChildren(p);
        }

        setProjects(dirs);
      }
    } catch {}
    setLoading(false);
  };

  const handleCreateRepo = async () => {
    const trimmed = newRepoName.trim();
    if (!trimmed) return;

    setCreating(true);
    setCreateError('');
    setCreateSuccess('');

    try {
      const result = await api.post<{ name: string; path: string; isGit: boolean }>(
        '/workspace/repositories',
        { name: trimmed, parentPath: repoParent || undefined, initGit },
      );

      if (result?.path) {
        setCreateSuccess(`Created "${result.name}"`);
        setProjectPath(result.path);

        // Refresh project list so the new repo appears
        await loadProjects();

        // Reset form after a brief success flash
        setTimeout(() => {
          setShowCreateRepo(false);
          setNewRepoName('');
          setInitGit(true);
          setCreateSuccess('');
        }, 1500);
      }
    } catch (err: any) {
      const msg = err?.message || err?.error || 'Failed to create repository';
      setCreateError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } finally {
      setCreating(false);
    }
  };

  const cancelCreateRepo = () => {
    setShowCreateRepo(false);
    setNewRepoName('');
    setCreateError('');
    setCreateSuccess('');
    setInitGit(true);
  };

  const handleCreate = () => {
    if (devMode && !projectPath) return;
    const name = projectPath ? projectPath.replace(/\\/g, '/').split('/').pop() || '' : '';
    onCreate({
      devMode,
      projectPath: devMode ? projectPath : undefined,
      projectName: devMode ? name : undefined,
    });
    // Reset state
    setDevMode(false);
    setProjectPath('');
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs">
      <div className="bg-surface-container rounded-2xl w-full max-w-md ring-1 ring-outline-variant/20 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-outline-variant/10">
          <h2 className="text-lg font-bold text-on-surface">New Session</h2>
          <button onClick={onClose} className="p-1 text-on-surface-variant hover:text-on-surface cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5">
          {/* Mode selector */}
          <div>
            <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant mb-3">Session Mode</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setDevMode(false)}
                className={cn(
                  'flex flex-col items-center gap-2 p-4 rounded-xl cursor-pointer transition-all',
                  !devMode
                    ? 'bg-primary/10 ring-2 ring-primary'
                    : 'bg-surface-container ring-1 ring-outline-variant/10 hover:ring-outline-variant/30'
                )}
              >
                <MessageSquare className={cn('w-6 h-6', !devMode ? 'text-primary' : 'text-on-surface-variant')} />
                <span className={cn('text-sm font-medium', !devMode ? 'text-on-surface' : 'text-on-surface-variant')}>Normal</span>
                <span className="text-xs text-on-surface-variant text-center">General assistant chat</span>
              </button>
              <button
                onClick={() => setDevMode(true)}
                className={cn(
                  'flex flex-col items-center gap-2 p-4 rounded-xl cursor-pointer transition-all',
                  devMode
                    ? 'bg-primary/10 ring-2 ring-primary'
                    : 'bg-surface-container ring-1 ring-outline-variant/10 hover:ring-outline-variant/30'
                )}
              >
                <Code2 className={cn('w-6 h-6', devMode ? 'text-primary' : 'text-on-surface-variant')} />
                <span className={cn('text-sm font-medium', devMode ? 'text-on-surface' : 'text-on-surface-variant')}>Development</span>
                <span className="text-xs text-on-surface-variant text-center">Pinned to a project</span>
              </button>
            </div>
          </div>

          {/* Project selector (dev mode only) */}
          {devMode && (
            <div>
              <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant mb-2">Project</p>
              <p className="text-xs text-on-surface-variant mb-2">
                Projects are subfolders of your workspace root and any additional paths
                configured in Settings → Integrations.
              </p>
              <div className="relative">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                    <input
                      type="text"
                      value={projectPath}
                      onChange={(e) => setProjectPath(e.target.value)}
                      onFocus={() => setShowDropdown(true)}
                      placeholder={projects.length > 0 ? 'Select a project…' : 'No projects found — add a path in Settings → Integrations'}
                      className="w-full pl-10 pr-8 py-2.5 bg-surface-container border border-outline-variant/10 rounded-lg text-sm text-on-surface placeholder-on-surface-variant focus:ring-2 focus:ring-primary"
                    />
                    {projects.length > 0 && (
                      <button
                        onClick={() => setShowDropdown(!showDropdown)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-on-surface-variant hover:text-on-surface cursor-pointer"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Dropdown */}
                {showDropdown && projects.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-surface-container border border-outline-variant/10 rounded-lg shadow-xl max-h-48 overflow-y-auto">
                    {loading ? (
                      <div className="p-3 text-center text-on-surface-variant">
                        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                        Loading...
                      </div>
                    ) : (
                      projects
                        .filter(p => !projectPath || p.name.toLowerCase().includes(projectPath.toLowerCase()) || p.path.toLowerCase().includes(projectPath.toLowerCase()))
                        .map((project) => (
                          <button
                            key={project.path}
                            onClick={() => {
                              setProjectPath(project.path);
                              setShowDropdown(false);
                            }}
                            className="w-full px-3 py-2 text-left hover:bg-surface-container-high cursor-pointer flex items-center gap-2"
                          >
                            <FolderOpen className="w-4 h-4 text-on-surface-variant shrink-0" />
                            <div className="min-w-0">
                              <span className="text-sm text-on-surface block truncate">{project.name}</span>
                              <span className="text-xs text-on-surface-variant block truncate">{project.path}</span>
                            </div>
                          </button>
                        ))
                    )}
                  </div>
                )}
              </div>

              {/* Create new repository */}
              {!showCreateRepo ? (
                <button
                  onClick={() => {
                    setShowCreateRepo(true);
                    setShowDropdown(false);
                    setTimeout(() => repoInputRef.current?.focus(), 50);
                  }}
                  className="mt-2 flex items-center gap-1.5 text-xs text-primary hover:text-primary-container cursor-pointer transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Create new repository
                </button>
              ) : (
                <div className="mt-2 p-3 bg-surface-container border border-outline-variant/10 rounded-lg space-y-3">
                  {/* Parent folder — where the repo gets created */}
                  {parentFolders.length > 1 && (
                    <div>
                      <label className="block text-[11px] text-on-surface-variant mb-1">Parent folder</label>
                      <div className="relative">
                        <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant pointer-events-none" />
                        <select
                          value={repoParent}
                          onChange={(e) => setRepoParent(e.target.value)}
                          className="w-full appearance-none pl-10 pr-8 py-2.5 bg-surface-container border border-outline-variant/10 rounded-lg text-sm text-on-surface cursor-pointer focus:ring-2 focus:ring-primary"
                        >
                          {parentFolders.map((f) => (
                            <option key={f.path} value={f.path}>
                              {f.name} — {f.path}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant pointer-events-none" />
                      </div>
                    </div>
                  )}

                  {/* Repo name input */}
                  <div>
                    <input
                      ref={repoInputRef}
                      type="text"
                      value={newRepoName}
                      onChange={(e) => {
                        setNewRepoName(e.target.value);
                        setCreateError('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newRepoName.trim()) handleCreateRepo();
                        if (e.key === 'Escape') cancelCreateRepo();
                      }}
                      placeholder="Repository name..."
                      className="w-full px-3 py-2 bg-background border border-outline-variant/10 rounded-lg text-sm text-on-surface placeholder-on-surface-variant focus:ring-2 focus:ring-primary"
                    />
                    {/* Destination preview so the user always sees where it lands */}
                    {repoParent && (
                      <p className="mt-1 text-[11px] text-on-surface-variant truncate">
                        Creates: <span className="font-mono">{repoParent}/{newRepoName.trim() || 'name'}</span>
                      </p>
                    )}
                  </div>

                  {/* Init git checkbox */}
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <div
                      onClick={() => setInitGit(!initGit)}
                      className={cn(
                        'w-4 h-4 rounded border flex items-center justify-center transition-colors',
                        initGit
                          ? 'bg-primary border-primary'
                          : 'border-outline-variant/40 bg-transparent'
                      )}
                    >
                      {initGit && <Check className="w-3 h-3 text-[#0e0e0e]" />}
                    </div>
                    <GitBranch className="w-3.5 h-3.5 text-on-surface-variant" />
                    <span className="text-xs text-on-surface-variant">Initialize Git</span>
                  </label>

                  {/* Error message */}
                  {createError && (
                    <p className="text-xs text-error">{createError}</p>
                  )}

                  {/* Success message */}
                  {createSuccess && (
                    <p className="text-xs text-tertiary">{createSuccess}</p>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreateRepo}
                      disabled={!newRepoName.trim() || creating}
                      className="px-3 py-1.5 text-xs font-medium bg-primary text-[#0e0e0e] rounded-md hover:bg-primary-container disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1.5"
                    >
                      {creating && <Loader2 className="w-3 h-3 animate-spin" />}
                      Create
                    </button>
                    <button
                      onClick={cancelCreateRepo}
                      disabled={creating}
                      className="px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer disabled:opacity-40"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-5 border-t border-outline-variant/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={devMode && !projectPath}
            className="px-5 py-2 text-sm font-medium bg-primary text-[#0e0e0e] rounded-lg hover:bg-primary-container disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Create Session
          </button>
        </div>
      </div>
    </div>
  );
}
