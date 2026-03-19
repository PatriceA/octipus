'use client';

import { useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileText,
  Loader2,
  Search,
  ChevronDown,
  ChevronRight,
  Upload,
  X,
  Eye,
  Clock,
  HardDrive,
  Tag,
  Plus,
} from 'lucide-react';
import { api, getApiUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Document {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  category: string | null;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  summary: string | null;
  ocrText?: string;
  storagePath?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  processedAt?: string | null;
}

interface DocumentsResponse {
  documents: Document[];
  queue: { queueLength: number; isProcessing: boolean };
}

const CATEGORY_COLORS: Record<string, string> = {
  invoices: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  contracts: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  reports: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  correspondence: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  technical: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  receipts: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  legal: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  medical: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300',
  financial: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
};

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 animate-pulse',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
}

function getStatusColor(status: string): string {
  return STATUS_COLORS[status] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

// --- Upload Dialog ---
function UploadDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList | null) => {
    if (files) {
      setSelectedFiles(Array.from(files));
      setError('');
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, []);

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      setError('Please select files to upload');
      return;
    }
    setError('');
    setUploading(true);
    try {
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));

      const token = api.getToken();
      const apiUrl = getApiUrl();
      const response = await fetch(`${apiUrl}/documents/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      queryClient.invalidateQueries({ queryKey: ['documents'] });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Upload Documents</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={cn(
              'border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer',
              dragOver
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-8 h-8 text-gray-400 mx-auto mb-3" />
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
              Drag and drop files here, or click to browse
            </p>
            <p className="text-xs text-gray-400">Any file type accepted</p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>

          {selectedFiles.length > 0 && (
            <div className="space-y-1.5">
              {selectedFiles.map((file, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 rounded-lg px-3 py-2">
                  <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <span className="flex-1 truncate">{file.name}</span>
                  <span className="text-xs text-gray-400">{formatSize(file.size)}</span>
                  <button
                    onClick={() => setSelectedFiles(selectedFiles.filter((_, idx) => idx !== i))}
                    className="text-gray-400 hover:text-red-500 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleUpload}
              disabled={uploading || selectedFiles.length === 0}
              className="px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Upload {selectedFiles.length > 0 ? `(${selectedFiles.length})` : ''}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Detail Dialog ---
function DetailDialog({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['document', documentId],
    queryFn: async () => {
      return await api.get<Document>(`/documents/${documentId}`);
    },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Document Details</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {isLoading ? (
            <div className="text-center py-8 text-gray-500">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
              Loading...
            </div>
          ) : data ? (
            <>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-primary-500" />
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">{data.originalName}</h3>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="text-sm">
                    <span className="text-gray-500">Type:</span>{' '}
                    <span className="text-gray-700 dark:text-gray-300">{data.mimeType}</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-gray-500">Size:</span>{' '}
                    <span className="text-gray-700 dark:text-gray-300">{formatSize(data.size)}</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-gray-500">Status:</span>{' '}
                    <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getStatusColor(data.status))}>
                      {data.status}
                    </span>
                  </div>
                  {data.category && (
                    <div className="text-sm">
                      <span className="text-gray-500">Category:</span>{' '}
                      <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getCategoryColor(data.category))}>
                        {data.category}
                      </span>
                    </div>
                  )}
                  <div className="text-sm">
                    <span className="text-gray-500">Created:</span>{' '}
                    <span className="text-gray-700 dark:text-gray-300">{formatDate(data.createdAt)}</span>
                  </div>
                  {data.processedAt && (
                    <div className="text-sm">
                      <span className="text-gray-500">Processed:</span>{' '}
                      <span className="text-gray-700 dark:text-gray-300">{formatDate(data.processedAt)}</span>
                    </div>
                  )}
                </div>
                {data.storagePath && (
                  <div className="text-sm">
                    <span className="text-gray-500">Path:</span>{' '}
                    <span className="text-gray-700 dark:text-gray-300 font-mono text-xs">{data.storagePath}</span>
                  </div>
                )}
              </div>

              {data.summary && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Summary</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                    {data.summary}
                  </p>
                </div>
              )}

              {data.ocrText && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">OCR Text</h4>
                  <pre className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-64 overflow-y-auto">
                    {data.ocrText}
                  </pre>
                </div>
              )}

              {data.metadata && Object.keys(data.metadata).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Metadata</h4>
                  <pre className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-48 overflow-y-auto">
                    {JSON.stringify(data.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-8 text-gray-500">Document not found</div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Document Card ---
function DocumentCard({
  document,
  onViewDetail,
}: {
  document: Document;
  onViewDetail: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between text-left cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="text-gray-500">
            {expanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </div>
          <FileText className="w-5 h-5 text-primary-500 flex-shrink-0" />
          <div className="min-w-0">
            <h3 className="font-medium text-gray-900 dark:text-gray-100 truncate">{document.originalName}</h3>
            <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
              <span className="flex items-center gap-1">
                <HardDrive className="w-3 h-3" />
                {formatSize(document.size)}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDate(document.createdAt)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {document.category && (
            <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getCategoryColor(document.category))}>
              {document.category}
            </span>
          )}
          <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getStatusColor(document.status))}>
            {document.status}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onViewDetail(document.id);
            }}
            className="p-1 text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer"
            title="View details"
          >
            <Eye className="w-4 h-4" />
          </button>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-4">
          {document.summary && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                <Tag className="w-4 h-4 text-primary-500" />
                Summary
              </h4>
              <p className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                {document.summary}
              </p>
            </div>
          )}

          {document.ocrText && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-primary-500" />
                OCR Text
              </h4>
              <pre className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-48 overflow-y-auto">
                {document.ocrText}
              </pre>
            </div>
          )}

          {document.metadata && Object.keys(document.metadata).length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Metadata</h4>
              <pre className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-32 overflow-y-auto">
                {JSON.stringify(document.metadata, null, 2)}
              </pre>
            </div>
          )}

          {!document.summary && !document.ocrText && (!document.metadata || Object.keys(document.metadata).length === 0) && (
            <p className="text-sm text-gray-500 italic">No additional details available yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function DocumentsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [viewingDocId, setViewingDocId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn: async () => {
      try {
        return await api.get<DocumentsResponse>('/documents');
      } catch {
        return { documents: [], queue: { queueLength: 0, isProcessing: false } };
      }
    },
    refetchInterval: 10000,
  });

  const documents = data?.documents || [];
  const queue = data?.queue || { queueLength: 0, isProcessing: false };

  const categories = Array.from(new Set(documents.map((d) => d.category).filter(Boolean) as string[])).sort();

  const filtered = documents.filter((d) => {
    if (categoryFilter && d.category !== categoryFilter) return false;
    if (statusFilter && d.status !== statusFilter) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return d.originalName.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
          <FileText className="w-5 h-5 text-primary-700 dark:text-primary-400" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Documents</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {documents.length} document{documents.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Upload
        </button>
      </div>

      {/* Queue status banner */}
      {(queue.queueLength > 0 || queue.isProcessing) && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-lg text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>
            Processing: {queue.queueLength} queued{queue.isProcessing ? ', 1 in progress' : ''}
          </span>
        </div>
      )}

      {/* Search + Category filter + Status filter */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search documents by name..."
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          <button
            onClick={() => setCategoryFilter(null)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors',
              !categoryFilter
                ? 'bg-primary-800 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
            )}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors',
                categoryFilter === cat
                  ? 'bg-primary-800 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              )}
            >
              {cat}
            </button>
          ))}
        </div>
        <select
          value={statusFilter || ''}
          onChange={(e) => setStatusFilter(e.target.value || null)}
          className="px-3 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
        >
          <option value="">All statuses</option>
          <option value="queued">Queued</option>
          <option value="processing">Processing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {/* Documents list */}
      {isLoading ? (
        <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8 text-center text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8 text-center">
          <FileText className="w-8 h-8 text-gray-500 mx-auto mb-2" />
          <p className="text-gray-500">No documents found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              onViewDetail={setViewingDocId}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {showUpload && <UploadDialog onClose={() => setShowUpload(false)} />}
      {viewingDocId && <DetailDialog documentId={viewingDocId} onClose={() => setViewingDocId(null)} />}
    </div>
  );
}
