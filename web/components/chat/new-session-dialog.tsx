'use client';

import { useState, useEffect } from 'react';
import { Code2, MessageSquare, FolderOpen, Loader2, X, ChevronDown } from 'lucide-react';
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
        // List directories under workspace root
        const result = await api.post<{ result: { entries: Array<{ name: string; isDirectory: boolean }> } }>(
          '/tools/filesystem/tools/list_directory/execute',
          { args: { path: ws.rootPath, recursive: false } },
        );
        const entries = result?.result?.entries || [];
        const dirs = entries
          .filter((e: any) => e.isDirectory && !e.name.startsWith('.'))
          .map((e: any) => ({
            name: e.name,
            path: `${ws.rootPath}/${e.name}`.replace(/\\/g, '/'),
            hasGit: false,
            hasSummary: false,
          }));

        // Also add additional paths
        for (const p of ws.additionalPaths || []) {
          const name = p.split(/[/\\]/).pop() || p;
          if (!dirs.find((d: ProjectEntry) => d.path === p)) {
            dirs.push({ name, path: p, hasGit: false, hasSummary: false });
          }
        }

        setProjects(dirs);
      }
    } catch {}
    setLoading(false);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface-container rounded-2xl w-full max-w-md ring-1 ring-outline-variant/20 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-outline-variant/10">
          <h2 className="text-lg font-bold text-white">New Session</h2>
          <button onClick={onClose} className="p-1 text-on-surface-variant hover:text-white cursor-pointer">
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
                    : 'bg-[#1a1a1a] ring-1 ring-outline-variant/10 hover:ring-outline-variant/30'
                )}
              >
                <MessageSquare className={cn('w-6 h-6', !devMode ? 'text-primary' : 'text-on-surface-variant')} />
                <span className={cn('text-sm font-medium', !devMode ? 'text-white' : 'text-on-surface-variant')}>Normal</span>
                <span className="text-xs text-on-surface-variant text-center">General assistant chat</span>
              </button>
              <button
                onClick={() => setDevMode(true)}
                className={cn(
                  'flex flex-col items-center gap-2 p-4 rounded-xl cursor-pointer transition-all',
                  devMode
                    ? 'bg-primary/10 ring-2 ring-primary'
                    : 'bg-[#1a1a1a] ring-1 ring-outline-variant/10 hover:ring-outline-variant/30'
                )}
              >
                <Code2 className={cn('w-6 h-6', devMode ? 'text-primary' : 'text-on-surface-variant')} />
                <span className={cn('text-sm font-medium', devMode ? 'text-white' : 'text-on-surface-variant')}>Development</span>
                <span className="text-xs text-on-surface-variant text-center">Pinned to a project</span>
              </button>
            </div>
          </div>

          {/* Project selector (dev mode only) */}
          {devMode && (
            <div>
              <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant mb-2">Project</p>
              <div className="relative">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                    <input
                      type="text"
                      value={projectPath}
                      onChange={(e) => setProjectPath(e.target.value)}
                      onFocus={() => setShowDropdown(true)}
                      placeholder="Select or enter project path..."
                      className="w-full pl-10 pr-8 py-2.5 bg-[#1a1a1a] border border-outline-variant/10 rounded-lg text-sm text-white placeholder-on-surface-variant focus:ring-2 focus:ring-primary"
                    />
                    {projects.length > 0 && (
                      <button
                        onClick={() => setShowDropdown(!showDropdown)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-on-surface-variant hover:text-white cursor-pointer"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Dropdown */}
                {showDropdown && projects.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-[#1a1a1a] border border-outline-variant/10 rounded-lg shadow-xl max-h-48 overflow-y-auto">
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
                            className="w-full px-3 py-2 text-left hover:bg-[#262626] cursor-pointer flex items-center gap-2"
                          >
                            <FolderOpen className="w-4 h-4 text-on-surface-variant shrink-0" />
                            <div className="min-w-0">
                              <span className="text-sm text-white block truncate">{project.name}</span>
                              <span className="text-xs text-on-surface-variant block truncate">{project.path}</span>
                            </div>
                          </button>
                        ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-5 border-t border-outline-variant/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-white cursor-pointer"
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
