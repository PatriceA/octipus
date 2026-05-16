'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Brain,
  ChevronDown,
  Code,
  Database,
  File,
  FileText,
  FolderOpen,
  FolderUp,
  Loader2,
  MessageSquare,
  Search,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// --- Types ---

interface KnowledgeEntry {
  id: string;
  sourceType: string;
  sourceId: string;
  abstract: string | null;
  metadata: {
    chunkIndex?: number;
    totalChunks?: number;
    originalLength?: number;
    language?: string;
    filePath?: string;
  };
  createdAt: string;
}

interface KnowledgeDetail extends KnowledgeEntry {
  content: string;
  similarity?: number;
}

interface SearchResult {
  id: string;
  content: string;
  abstract: string | null;
  sourceType: string;
  sourceId: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

interface KnowledgeStats {
  total: number;
  bySourceType: Record<string, number>;
  models: string[];
}

interface KBReadiness {
  ready: boolean;
  reason?: string;
  checks: {
    db: { ok: boolean; detail?: string };
    embeddingModel: { ok: boolean; detail?: string; modelId?: string };
    vectorWrite: { ok: boolean; detail?: string };
  };
  lastCheckedAt: string;
}

// --- Constants ---

const SOURCE_TYPE_COLORS: Record<string, string> = {
  document: 'bg-blue-900/30 text-primary',
  code: 'bg-green-900/30 text-tertiary',
  message: 'bg-purple-900/30 text-primary',
};

const SOURCE_TYPE_ICONS: Record<string, typeof FileText> = {
  document: FileText,
  code: Code,
  message: MessageSquare,
};

function getSourceTypeColor(sourceType: string): string {
  return SOURCE_TYPE_COLORS[sourceType] || 'bg-surface-container-high text-on-surface-variant';
}

function SourceTypeIcon({ sourceType, className }: { sourceType: string; className?: string }) {
  const Icon = SOURCE_TYPE_ICONS[sourceType] || Database;
  return <Icon className={className} />;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --- Entry Detail Dialog ---

function EntryDetailDialog({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const { data: entry, isLoading } = useQuery({
    queryKey: ['knowledge', entryId],
    queryFn: () => api.get<KnowledgeDetail>(`/knowledge/${entryId}`),
  });

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setError('');
    try {
      await api.delete(`/knowledge/${entryId}`);
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-stats'] });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete entry');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface">Entry Detail</h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-on-surface-variant">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
            Loading...
          </div>
        ) : entry ? (
          <div className="p-4 space-y-4">
            {error && (
              <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Abstract */}
            {entry.abstract && (
              <div>
                <h4 className="text-sm font-medium text-on-surface/80 mb-1">Abstract</h4>
                <p className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3">
                  {entry.abstract}
                </p>
              </div>
            )}

            {/* Content */}
            <div>
              <h4 className="text-sm font-medium text-on-surface/80 mb-1">Content</h4>
              <pre className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-96 overflow-y-auto">
                {entry.content}
              </pre>
            </div>

            {/* Metadata table */}
            <div>
              <h4 className="text-sm font-medium text-on-surface/80 mb-1">Metadata</h4>
              <div className="bg-surface-container-low rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    <tr className="border-b border-outline-variant/10">
                      <td className="px-3 py-2 font-medium text-on-surface/80 w-40">Source Type</td>
                      <td className="px-3 py-2">
                        <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getSourceTypeColor(entry.sourceType))}>
                          {entry.sourceType}
                        </span>
                      </td>
                    </tr>
                    <tr className="border-b border-outline-variant/10">
                      <td className="px-3 py-2 font-medium text-on-surface/80">Source ID</td>
                      <td className="px-3 py-2 text-on-surface-variant font-mono text-xs break-all">{entry.sourceId}</td>
                    </tr>
                    <tr className="border-b border-outline-variant/10">
                      <td className="px-3 py-2 font-medium text-on-surface/80">Created</td>
                      <td className="px-3 py-2 text-on-surface-variant">{formatDate(entry.createdAt)}</td>
                    </tr>
                    {entry.metadata?.filePath && (
                      <tr className="border-b border-outline-variant/10">
                        <td className="px-3 py-2 font-medium text-on-surface/80">File Path</td>
                        <td className="px-3 py-2 text-on-surface-variant font-mono text-xs break-all">{entry.metadata.filePath}</td>
                      </tr>
                    )}
                    {entry.metadata?.language && (
                      <tr className="border-b border-outline-variant/10">
                        <td className="px-3 py-2 font-medium text-on-surface/80">Language</td>
                        <td className="px-3 py-2 text-on-surface-variant">{entry.metadata.language}</td>
                      </tr>
                    )}
                    {entry.metadata?.chunkIndex !== undefined && (
                      <tr className="border-b border-outline-variant/10">
                        <td className="px-3 py-2 font-medium text-on-surface/80">Chunk</td>
                        <td className="px-3 py-2 text-on-surface-variant">
                          {entry.metadata.chunkIndex + 1} of {entry.metadata.totalChunks || '?'}
                        </td>
                      </tr>
                    )}
                    {entry.metadata?.originalLength !== undefined && (
                      <tr>
                        <td className="px-3 py-2 font-medium text-on-surface/80">Original Length</td>
                        <td className="px-3 py-2 text-on-surface-variant">{entry.metadata.originalLength.toLocaleString()} chars</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Delete button */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => { setConfirmDelete(false); onClose(); }}
                className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg hover:bg-surface-container-high cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className={cn(
                  'px-4 py-2 text-sm rounded-lg cursor-pointer disabled:opacity-50',
                  confirmDelete
                    ? 'bg-red-600 text-on-surface hover:bg-red-700'
                    : 'bg-red-900/30 text-error hover:bg-red-900/50'
                )}
              >
                {deleting ? 'Deleting...' : confirmDelete ? 'Confirm Delete' : 'Delete'}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-on-surface-variant">Entry not found</div>
        )}
      </div>
    </div>
  );
}

// --- Index Files Dialog ---

function IndexFilesDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('');
  const [type, setType] = useState<'file' | 'directory'>('file');
  const [sourceType, setSourceType] = useState<'document' | 'code'>('document');
  const [patterns, setPatterns] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) {
      setError('Path is required');
      return;
    }
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        path: path.trim(),
        type,
        sourceType,
      };
      if (type === 'directory' && patterns.trim()) {
        body.patterns = patterns.split(',').map((p) => p.trim()).filter(Boolean);
      }
      await api.post('/knowledge/index', body);
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-stats'] });
      setSuccess('Indexing started successfully');
      setTimeout(() => onClose(), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to index files');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface">Index Files</h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {success && (
            <div className="text-sm text-tertiary bg-green-900/20 rounded-lg px-3 py-2">
              {success}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-on-surface/80 mb-1">Path</label>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/file/or/directory"
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface/80 mb-1">Type</label>
            <div className="flex rounded-lg bg-surface-container-high p-0.5">
              <button
                type="button"
                onClick={() => setType('file')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors flex-1 justify-center',
                  type === 'file' ? 'bg-surface-container-high text-on-surface shadow-xs' : 'text-on-surface-variant'
                )}
              >
                <File className="w-3.5 h-3.5" /> File
              </button>
              <button
                type="button"
                onClick={() => setType('directory')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors flex-1 justify-center',
                  type === 'directory' ? 'bg-surface-container-high text-on-surface shadow-xs' : 'text-on-surface-variant'
                )}
              >
                <FolderOpen className="w-3.5 h-3.5" /> Directory
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface/80 mb-1">Source Type</label>
            <div className="flex rounded-lg bg-surface-container-high p-0.5">
              <button
                type="button"
                onClick={() => setSourceType('document')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors flex-1 justify-center',
                  sourceType === 'document' ? 'bg-surface-container-high text-on-surface shadow-xs' : 'text-on-surface-variant'
                )}
              >
                <FileText className="w-3.5 h-3.5" /> Document
              </button>
              <button
                type="button"
                onClick={() => setSourceType('code')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors flex-1 justify-center',
                  sourceType === 'code' ? 'bg-surface-container-high text-on-surface shadow-xs' : 'text-on-surface-variant'
                )}
              >
                <Code className="w-3.5 h-3.5" /> Code
              </button>
            </div>
          </div>

          {type === 'directory' && (
            <div>
              <label className="block text-sm font-medium text-on-surface/80 mb-1">
                Patterns
                <span className="ml-2 text-xs font-normal text-on-surface-variant">Comma-separated globs</span>
              </label>
              <input
                type="text"
                value={patterns}
                onChange={(e) => setPatterns(e.target.value)}
                placeholder="*.ts, *.md, src/**/*.tsx"
                className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface font-mono"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg hover:bg-surface-container-high cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer"
            >
              {submitting ? 'Indexing...' : 'Index'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Main Page ---

export default function KnowledgePage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'hybrid' | 'semantic' | 'keyword'>('hybrid');
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string>('all');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState('');
  const [activeSearch, setActiveSearch] = useState('');

  const [browseOffset, setBrowseOffset] = useState(0);
  const [allEntries, setAllEntries] = useState<KnowledgeEntry[]>([]);

  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [showIndexDialog, setShowIndexDialog] = useState(false);

  const BROWSE_LIMIT = 20;

  // Stats query — surface errors in the banner instead of swallowing them.
  const { data: stats, error: statsError } = useQuery({
    queryKey: ['knowledge-stats'],
    queryFn: () => api.get<KnowledgeStats>('/knowledge/stats'),
    retry: false,
  });

  // Readiness check — 503 means the KB is broken; we show a banner with the reason.
  const { data: readiness, error: readinessError } = useQuery({
    queryKey: ['knowledge-readiness'],
    queryFn: () => api.get<KBReadiness>('/knowledge/readiness'),
    retry: false,
    refetchInterval: 30000, // re-check every 30s so the banner clears once fixed
  });

  const kbNotReadyMessage = (() => {
    if (readiness && readiness.ready === false) return readiness.reason || 'Knowledge base is not ready';
    if (readinessError instanceof Error) return readinessError.message;
    return null;
  })();

  // Browse query
  const { data: browseData, isLoading: browseLoading } = useQuery({
    queryKey: ['knowledge', 'browse', browseOffset, sourceTypeFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(BROWSE_LIMIT), offset: String(browseOffset) });
      if (sourceTypeFilter !== 'all') params.set('sourceType', sourceTypeFilter);
      return await api.get<{ entries: KnowledgeEntry[]; total: number }>(`/knowledge?${params}`);
    },
  });

  // Update accumulated entries when browse data changes
  const browseEntries = browseData?.entries || [];
  const browseTotal = browseData?.total || 0;

  // Accumulate entries for "Load More"
  if (browseEntries.length > 0) {
    const existingIds = new Set(allEntries.map((e) => e.id));
    const newEntries = browseEntries.filter((e) => !existingIds.has(e.id));
    if (newEntries.length > 0 && browseOffset > 0) {
      // Only merge if we're loading more (offset > 0)
      // For initial load or filter change, replace
    }
  }

  const displayedEntries = browseOffset === 0 ? browseEntries : [...allEntries, ...browseEntries.filter((e) => !allEntries.some((a) => a.id === e.id))];

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError('');
    setSearchResults(null);
    try {
      const body: Record<string, unknown> = {
        query: searchQuery.trim(),
        mode: searchMode,
        limit: 20,
      };
      if (sourceTypeFilter !== 'all') body.sourceType = sourceTypeFilter;
      const result = await api.post<{ results: SearchResult[] }>('/knowledge/search', body);
      setSearchResults(result.results);
      setActiveSearch(searchQuery.trim());
    } catch (err: unknown) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchResults(null);
    setActiveSearch('');
    setSearchQuery('');
  };

  const handleLoadMore = () => {
    setAllEntries(displayedEntries);
    setBrowseOffset(browseOffset + BROWSE_LIMIT);
  };

  const handleFilterChange = (value: string) => {
    setSourceTypeFilter(value);
    setBrowseOffset(0);
    setAllEntries([]);
    if (searchResults) {
      clearSearch();
    }
  };

  const hasMore = browseOffset + BROWSE_LIMIT < browseTotal;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Brain className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl text-on-surface">Knowledge Base</h1>
          <p className="text-on-surface-variant">
            RAG knowledge base powered by pgvector. Search indexed documents, code, and conversation messages using hybrid semantic + keyword search.
          </p>
          <p className="text-sm text-on-surface-variant mt-1">
            {stats?.total ?? 0} entries indexed across {Object.keys(stats?.bySourceType || {}).length} source types
          </p>
        </div>
        <button
          onClick={() => setShowIndexDialog(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim cursor-pointer"
          disabled={!!kbNotReadyMessage}
          title={kbNotReadyMessage ? 'Knowledge base is not ready — fix configuration below' : undefined}
        >
          <FolderUp className="w-4 h-4" />
          Index Files
        </button>
      </div>

      {/* KB readiness / stats error banner — matches existing error-display pattern */}
      {kbNotReadyMessage && (
        <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2 border border-red-900/40">
          <div className="font-medium">Knowledge base is not ready</div>
          <div className="text-xs mt-1 opacity-90 wrap-break-word">{kbNotReadyMessage}</div>
          {readiness && (
            <ul className="text-xs mt-2 space-y-0.5 list-disc list-inside opacity-90">
              <li>Database: {readiness.checks.db.ok ? 'OK' : `FAIL — ${readiness.checks.db.detail || 'unknown'}`}</li>
              <li>Embedding model: {readiness.checks.embeddingModel.ok ? `OK (${readiness.checks.embeddingModel.modelId || 'resolved'})` : `FAIL — ${readiness.checks.embeddingModel.detail || 'unknown'}`}</li>
              <li>Vector write: {readiness.checks.vectorWrite.ok ? 'OK' : `FAIL — ${readiness.checks.vectorWrite.detail || 'unknown'}`}</li>
            </ul>
          )}
        </div>
      )}
      {statsError instanceof Error && !kbNotReadyMessage && (
        <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
          Failed to load stats: {statsError.message}
        </div>
      )}

      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-surface-variant/60 backdrop-blur-sm rounded-2xl border border-outline-variant/10 shadow-[0_0_30px_-12px_rgba(115,255,227,0.12)] p-4">
          <p className="text-2xl font-bold text-on-surface">{stats?.total ?? 0}</p>
          <p className="text-xs text-on-surface-variant">Total Entries</p>
        </div>
        <div className="bg-surface-variant/60 backdrop-blur-sm rounded-2xl border border-outline-variant/10 shadow-[0_0_30px_-12px_rgba(115,255,227,0.12)] p-4">
          <p className="text-2xl font-bold text-primary">{stats?.bySourceType?.document ?? 0}</p>
          <p className="text-xs text-on-surface-variant">Documents</p>
        </div>
        <div className="bg-surface-variant/60 backdrop-blur-sm rounded-2xl border border-outline-variant/10 shadow-[0_0_30px_-12px_rgba(115,255,227,0.12)] p-4">
          <p className="text-2xl font-bold text-tertiary">{stats?.bySourceType?.code ?? 0}</p>
          <p className="text-xs text-on-surface-variant">Code</p>
        </div>
      </div>

      {/* Search section */}
      <div className="space-y-3">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              placeholder="Search knowledge base..."
              className="w-full pl-10 pr-4 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
            />
          </div>

          {/* Source type filter */}
          <div className="relative">
            <select
              value={sourceTypeFilter}
              onChange={(e) => handleFilterChange(e.target.value)}
              className="appearance-none pl-3 pr-8 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface cursor-pointer"
            >
              <option value="all">All Types</option>
              <option value="document">Document</option>
              <option value="message">Message</option>
              <option value="code">Code</option>
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant pointer-events-none" />
          </div>

          <button
            onClick={handleSearch}
            disabled={isSearching || !searchQuery.trim()}
            className="px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer"
          >
            {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
          </button>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-on-surface-variant">Mode:</span>
          <div className="flex rounded-lg bg-surface-container-high p-0.5">
            {(['hybrid', 'semantic', 'keyword'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSearchMode(mode)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors capitalize',
                  searchMode === mode
                    ? 'bg-primary text-on-surface shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                )}
              >
                {mode}
              </button>
            ))}
          </div>
          {activeSearch && (
            <button
              onClick={clearSearch}
              className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer"
            >
              <X className="w-3 h-3" />
              Clear search
            </button>
          )}
        </div>
      </div>

      {/* Search error */}
      {searchError && (
        <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
          {searchError}
        </div>
      )}

      {/* Search results */}
      {searchResults !== null ? (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-on-surface/80">
            {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for &ldquo;{activeSearch}&rdquo;
          </h3>
          {searchResults.length === 0 ? (
            <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center">
              <Search className="w-8 h-8 text-on-surface-variant mx-auto mb-2" />
              <p className="text-on-surface-variant">No results found</p>
            </div>
          ) : (
            searchResults.map((result) => (
              <button
                key={result.id}
                onClick={() => setSelectedEntryId(result.id)}
                className="w-full text-left bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4 hover:ring-primary/30 transition-colors cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-on-surface/80 line-clamp-2">
                      {result.abstract || result.content.slice(0, 200)}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getSourceTypeColor(result.sourceType))}>
                        {result.sourceType}
                      </span>
                      {(result.metadata as KnowledgeEntry['metadata'])?.filePath && (
                        <span className="text-xs text-on-surface-variant font-mono truncate">
                          {(result.metadata as KnowledgeEntry['metadata']).filePath}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary font-medium">
                    {(result.similarity * 100).toFixed(1)}%
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      ) : (
        /* Browse section */
        <div className="space-y-3">
          {browseLoading && browseOffset === 0 ? (
            <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center text-on-surface-variant">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
              Loading...
            </div>
          ) : displayedEntries.length === 0 ? (
            <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center">
              <Brain className="w-8 h-8 text-on-surface-variant mx-auto mb-2" />
              <p className="text-on-surface-variant">No knowledge entries found</p>
              <p className="text-xs text-on-surface-variant mt-1">Click &quot;Index Files&quot; to add documents or code to the knowledge base for semantic retrieval.</p>
            </div>
          ) : (
            <>
              {displayedEntries.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => setSelectedEntryId(entry.id)}
                  className="w-full text-left bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4 hover:ring-primary/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-start gap-3">
                    <SourceTypeIcon sourceType={entry.sourceType} className="w-4 h-4 text-on-surface-variant mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-on-surface/80 line-clamp-2">
                        {entry.abstract || entry.sourceId}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getSourceTypeColor(entry.sourceType))}>
                          {entry.sourceType}
                        </span>
                        {entry.metadata?.filePath && (
                          <span className="text-xs text-on-surface-variant font-mono truncate">
                            {entry.metadata.filePath}
                          </span>
                        )}
                        <span className="text-xs text-on-surface-variant ml-auto shrink-0">
                          {formatDate(entry.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}

              {hasMore && (
                <div className="text-center pt-2">
                  <button
                    onClick={handleLoadMore}
                    disabled={browseLoading}
                    className="px-6 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg hover:bg-surface-container-high cursor-pointer disabled:opacity-50"
                  >
                    {browseLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                        Loading...
                      </>
                    ) : (
                      `Load More (${displayedEntries.length} of ${browseTotal})`
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Dialogs */}
      {selectedEntryId && <EntryDetailDialog entryId={selectedEntryId} onClose={() => setSelectedEntryId(null)} />}
      {showIndexDialog && <IndexFilesDialog onClose={() => setShowIndexDialog(false)} />}
    </div>
  );
}
