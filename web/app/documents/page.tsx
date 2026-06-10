'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Eye,
  FileText,
  HardDrive,
  Loader2,
  Plus,
  Search,
  Square,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/ui/markdown-renderer';
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
  invoices: 'bg-emerald-900/30 text-tertiary',
  contracts: 'bg-blue-900/30 text-primary',
  reports: 'bg-purple-900/30 text-primary',
  correspondence: 'bg-yellow-900/30 text-warning',
  technical: 'bg-indigo-900/30 text-primary',
  receipts: 'bg-orange-900/30 text-warning',
  legal: 'bg-red-900/30 text-error',
  medical: 'bg-pink-900/30 text-error',
  financial: 'bg-teal-900/30 text-tertiary',
};

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-yellow-900/30 text-warning',
  processing: 'bg-blue-900/30 text-primary animate-pulse',
  completed: 'bg-green-900/30 text-tertiary',
  failed: 'bg-red-900/30 text-error',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || 'bg-surface-container-high text-on-surface-variant';
}

function getStatusColor(status: string): string {
  return STATUS_COLORS[status] || 'bg-surface-container-high text-on-surface-variant';
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
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface">Upload Documents</h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
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
                ? 'border-primary bg-primary/10'
                : 'border-outline-variant/10 hover:border-outline-variant/30'
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-8 h-8 text-on-surface-variant mx-auto mb-3" />
            <p className="text-sm text-on-surface-variant mb-1">
              Drag and drop files here, or click to browse
            </p>
            <p className="text-xs text-on-surface-variant">Any file type accepted</p>
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
                <div key={i} className="flex items-center gap-2 text-sm text-on-surface/80 bg-surface-container-low rounded-lg px-3 py-2">
                  <FileText className="w-4 h-4 text-on-surface-variant shrink-0" />
                  <span className="flex-1 truncate">{file.name}</span>
                  <span className="text-xs text-on-surface-variant">{formatSize(file.size)}</span>
                  <button
                    onClick={() => setSelectedFiles(selectedFiles.filter((_, idx) => idx !== i))}
                    className="text-on-surface-variant hover:text-error cursor-pointer"
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
              className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg hover:bg-surface-container-high cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleUpload}
              disabled={uploading || selectedFiles.length === 0}
              className="px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
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

// --- Document Preview ---
// Fetches the raw file as a blob with auth, then renders inline based on mime type.
// We do this via fetch + ObjectURL because <img>/<iframe> can't carry the Bearer
// header. The ObjectURL is revoked on unmount/change to avoid leaks.
function DocumentPreview({ documentId, mimeType, originalName }: { documentId: string; mimeType: string; originalName: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const isText =
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    /\.(md|csv|json|xml|yaml|yml|log|ini|conf|toml|html|htm|css|js|ts|py|sh|sql)$/i.test(originalName);
  // Markdown files render formatted (headings, lists, tables) instead of as a
  // raw monospace dump — Deep Research saves its reports here as .md.
  const isMarkdown = mimeType === 'text/markdown' || /\.(md|markdown)$/i.test(originalName);
  const previewable = isImage || isPdf || isText;

  useEffect(() => {
    if (!previewable) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    (async () => {
      setLoading(true);
      setError(null);
      setBlobUrl(null);
      setTextContent(null);
      try {
        const token = api.getToken();
        const res = await fetch(`${getApiUrl()}/documents/${documentId}/raw`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        if (isText) {
          const txt = await res.text();
          if (!cancelled) setTextContent(txt);
        } else {
          const blob = await res.blob();
          createdUrl = URL.createObjectURL(blob);
          if (!cancelled) setBlobUrl(createdUrl);
          else URL.revokeObjectURL(createdUrl);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Preview failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [documentId, isImage, isPdf, isText, previewable]);

  const handleDownload = async () => {
    try {
      const token = api.getToken();
      const res = await fetch(`${getApiUrl()}/documents/${documentId}/raw?download=1`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = originalName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium text-on-surface/80 flex items-center gap-1.5">
          <Eye className="w-4 h-4 text-primary" />
          Preview
        </h4>
        <button
          onClick={handleDownload}
          className="text-xs text-on-surface-variant hover:text-on-surface flex items-center gap-1 cursor-pointer"
          title="Download original file"
        >
          <Download className="w-3.5 h-3.5" />
          Download
        </button>
      </div>

      <div className="bg-surface-container-low rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-on-surface-variant text-sm">
            <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
            Loading preview…
          </div>
        ) : error ? (
          <div className="p-4 text-sm text-error">Preview failed: {error}</div>
        ) : !previewable ? (
          <div className="p-6 text-center text-sm text-on-surface-variant">
            Preview is not available for this file type ({mimeType || 'unknown'}). Use Download to view the original.
          </div>
        ) : isImage && blobUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={blobUrl} alt={originalName} className="max-w-full max-h-[60vh] mx-auto block" />
        ) : isPdf && blobUrl ? (
          <iframe src={blobUrl} title={originalName} className="w-full h-[60vh] bg-on-surface" />
        ) : isMarkdown && textContent !== null ? (
          <div className="p-3 max-h-[60vh] overflow-auto">
            <Markdown content={textContent} />
          </div>
        ) : isText && textContent !== null ? (
          <pre className="text-xs text-on-surface-variant whitespace-pre-wrap font-mono p-3 max-h-[60vh] overflow-auto">
            {textContent}
          </pre>
        ) : (
          <div className="p-4 text-sm text-on-surface-variant">No preview available.</div>
        )}
      </div>
    </div>
  );
}

// --- Detail Dialog ---
function DetailDialog({ documentId, onClose, onDelete, onCancel }: { documentId: string; onClose: () => void; onDelete: (id: string) => void; onCancel: (id: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['document', documentId],
    queryFn: async () => {
      return await api.get<Document>(`/documents/${documentId}`);
    },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface">Document Details</h2>
          <div className="flex items-center gap-2">
            {data && (data.status === 'queued' || data.status === 'processing') && (
              <button
                onClick={() => { onCancel(documentId); onClose(); }}
                className="px-3 py-1.5 text-xs font-medium text-warning bg-orange-900/30 rounded-lg hover:bg-orange-900/50 cursor-pointer flex items-center gap-1"
              >
                <Square className="w-3.5 h-3.5" />
                Cancel
              </button>
            )}
            <button
              onClick={() => { onDelete(documentId); onClose(); }}
              className="px-3 py-1.5 text-xs font-medium text-error bg-red-900/30 rounded-lg hover:bg-red-900/50 cursor-pointer flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
            <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {isLoading ? (
            <div className="text-center py-8 text-on-surface-variant">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
              Loading...
            </div>
          ) : data ? (
            <>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-primary" />
                  <h3 className="font-medium text-on-surface">{data.originalName}</h3>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="text-sm">
                    <span className="text-on-surface-variant">Type:</span>{' '}
                    <span className="text-on-surface/80">{data.mimeType}</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-on-surface-variant">Size:</span>{' '}
                    <span className="text-on-surface/80">{formatSize(data.size)}</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-on-surface-variant">Status:</span>{' '}
                    <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getStatusColor(data.status))}>
                      {data.status}
                    </span>
                  </div>
                  {data.category && (
                    <div className="text-sm">
                      <span className="text-on-surface-variant">Category:</span>{' '}
                      <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getCategoryColor(data.category))}>
                        {data.category}
                      </span>
                    </div>
                  )}
                  <div className="text-sm">
                    <span className="text-on-surface-variant">Created:</span>{' '}
                    <span className="text-on-surface/80">{formatDate(data.createdAt)}</span>
                  </div>
                  {data.processedAt && (
                    <div className="text-sm">
                      <span className="text-on-surface-variant">Processed:</span>{' '}
                      <span className="text-on-surface/80">{formatDate(data.processedAt)}</span>
                    </div>
                  )}
                </div>
                {data.storagePath && (
                  <div className="text-sm">
                    <span className="text-on-surface-variant">Path:</span>{' '}
                    <span className="text-on-surface/80 font-mono text-xs">{data.storagePath}</span>
                  </div>
                )}
              </div>

              <DocumentPreview
                documentId={data.id}
                mimeType={data.mimeType}
                originalName={data.originalName}
              />

              {data.summary && (
                <div>
                  <h4 className="text-sm font-medium text-on-surface/80 mb-2">Summary</h4>
                  <div className="text-on-surface-variant bg-surface-container-low rounded-lg p-3">
                    <Markdown content={data.summary} />
                  </div>
                </div>
              )}

              {data.ocrText && (
                <div>
                  <h4 className="text-sm font-medium text-on-surface/80 mb-2">OCR Text</h4>
                  <pre className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-64 overflow-y-auto">
                    {data.ocrText}
                  </pre>
                </div>
              )}

              {data.metadata && Object.keys(data.metadata).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-on-surface/80 mb-2">Metadata</h4>
                  <pre className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-48 overflow-y-auto">
                    {JSON.stringify(data.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-8 text-on-surface-variant">Document not found</div>
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
  onDelete,
  onCancel,
}: {
  document: Document;
  onViewDetail: (id: string) => void;
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between text-left cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="text-on-surface-variant">
            {expanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </div>
          <FileText className="w-5 h-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h3 className="font-medium text-on-surface truncate">{document.originalName}</h3>
            <div className="flex items-center gap-2 text-xs text-on-surface-variant mt-0.5">
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

        <div className="flex items-center gap-2 shrink-0">
          {document.category && (
            <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getCategoryColor(document.category))}>
              {document.category}
            </span>
          )}
          <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getStatusColor(document.status))}>
            {document.status}
          </span>
          {(document.status === 'queued' || document.status === 'processing') && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCancel(document.id);
              }}
              className="p-1 text-on-surface-variant hover:text-warning cursor-pointer"
              title="Cancel processing"
            >
              <Square className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onViewDetail(document.id);
            }}
            className="p-1 text-on-surface-variant hover:text-primary cursor-pointer"
            title="View details"
          >
            <Eye className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(document.id);
            }}
            className="p-1 text-on-surface-variant hover:text-error cursor-pointer"
            title="Delete document"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-outline-variant/10 p-4 space-y-4">
          {document.summary && (
            <div>
              <h4 className="text-sm font-medium text-on-surface/80 mb-2 flex items-center gap-1.5">
                <Tag className="w-4 h-4 text-primary" />
                Summary
              </h4>
              <p className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3">
                {document.summary}
              </p>
            </div>
          )}

          {document.ocrText && (
            <div>
              <h4 className="text-sm font-medium text-on-surface/80 mb-2 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-primary" />
                OCR Text
              </h4>
              <pre className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-48 overflow-y-auto">
                {document.ocrText}
              </pre>
            </div>
          )}

          {document.metadata && Object.keys(document.metadata).length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-on-surface/80 mb-2">Metadata</h4>
              <pre className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-32 overflow-y-auto">
                {JSON.stringify(document.metadata, null, 2)}
              </pre>
            </div>
          )}

          {!document.summary && !document.ocrText && (!document.metadata || Object.keys(document.metadata).length === 0) && (
            <p className="text-sm text-on-surface-variant italic">No additional details available yet.</p>
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
  const queryClient = useQueryClient();

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this document?')) return;
    try {
      await api.delete(`/documents/${id}`);
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await api.post(`/documents/${id}/cancel`);
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (err) {
      console.error('Failed to cancel document:', err);
    }
  };

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
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <FileText className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl text-on-surface">Documents</h1>
          <p className="text-on-surface-variant">
            Upload and manage documents. Files are processed with OCR, categorized by AI, and indexed into the knowledge base for retrieval.
          </p>
          <p className="text-sm text-on-surface-variant mt-1">
            {documents.length} document{documents.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Upload
        </button>
      </div>

      {/* Queue status banner */}
      {(queue.queueLength > 0 || queue.isProcessing) && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-900/20 text-primary rounded-lg text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>
            Processing: {queue.queueLength} queued{queue.isProcessing ? ', 1 in progress' : ''}
          </span>
        </div>
      )}

      {/* Search + Category filter + Status filter */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search documents by name..."
            className="w-full pl-10 pr-4 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          <button
            onClick={() => setCategoryFilter(null)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors',
              !categoryFilter
                ? 'bg-primary text-on-surface'
                : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-high'
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
                  ? 'bg-primary text-on-surface'
                  : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-high'
              )}
            >
              {cat}
            </button>
          ))}
        </div>
        <select
          value={statusFilter || ''}
          onChange={(e) => setStatusFilter(e.target.value || null)}
          className="px-3 py-1.5 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
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
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center">
          <FileText className="w-8 h-8 text-on-surface-variant mx-auto mb-2" />
          <p className="text-on-surface-variant">No documents found</p>
          <p className="text-sm text-on-surface-variant mt-1">Click &quot;Upload&quot; to add files. They will be processed with OCR and indexed automatically.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              onViewDetail={setViewingDocId}
              onDelete={handleDelete}
              onCancel={handleCancel}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {showUpload && <UploadDialog onClose={() => setShowUpload(false)} />}
      {viewingDocId && <DetailDialog documentId={viewingDocId} onClose={() => setViewingDocId(null)} onDelete={handleDelete} onCancel={handleCancel} />}
    </div>
  );
}
