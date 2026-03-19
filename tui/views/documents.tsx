import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface Document {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  category: string | null;
  status: string;
  summary: string | null;
  createdAt: string;
  processedAt?: string | null;
  ocrText?: string;
}

interface QueueInfo {
  queueLength: number;
  isProcessing: boolean;
}

type Mode = 'list' | 'detail';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

export function DocumentsView() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [detail, setDetail] = useState<Document | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchDocuments = async () => {
    try {
      const data = await api.get<{ documents: Document[]; queue: QueueInfo }>('/documents');
      setDocuments(data?.documents || []);
      setQueue(data?.queue || null);
      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  const fetchDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const data = await api.get<Document>(`/documents/${id}`);
      setDetail(data);
      setDetailLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  useInput((input, key) => {
    // Detail mode
    if (mode === 'detail') {
      if (key.escape) {
        setMode('list');
        setDetail(null);
      }
      return;
    }

    // List mode navigation
    if ((key.upArrow || input === 'k') && selected > 0) setSelected(s => s - 1);
    if ((key.downArrow || input === 'j') && selected < documents.length - 1) setSelected(s => s + 1);

    if (key.return && documents[selected]) {
      setMode('detail');
      fetchDetail(documents[selected].id);
    }

    if (input === 'r') {
      setLoading(true);
      fetchDocuments();
    }
  });

  if (loading) {
    return <Text color="yellow">Loading documents...</Text>;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  // Detail view
  if (mode === 'detail') {
    if (detailLoading) {
      return (
        <Box flexDirection="column">
          <Text bold underline>Documents</Text>
          <Text color="yellow">Loading document details...</Text>
        </Box>
      );
    }

    if (detail) {
      const ocrLines = detail.ocrText ? detail.ocrText.split('\n').slice(0, 30) : [];
      return (
        <Box flexDirection="column">
          <Text bold underline>Documents</Text>
          <Text color="gray">ESC to go back</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold color="cyan">{detail.originalName}</Text>
            <Text color="gray">Type: {detail.mimeType} | Size: {formatSize(detail.size)}</Text>
            <Text color="gray">Category: {detail.category || 'none'} | Status: {detail.status}</Text>
            <Text color="gray">Created: {formatDate(detail.createdAt)}{detail.processedAt ? ` | Processed: ${formatDate(detail.processedAt)}` : ''}</Text>

            {detail.summary && (
              <Box marginTop={1} flexDirection="column">
                <Text bold color="yellow">Summary:</Text>
                <Text color="white">{detail.summary}</Text>
              </Box>
            )}

            {ocrLines.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text bold color="magenta">OCR Text (first 30 lines):</Text>
                {ocrLines.map((line, i) => (
                  <Text key={i} color="white">{line.length > 100 ? line.slice(0, 100) + '...' : line}</Text>
                ))}
                {detail.ocrText && detail.ocrText.split('\n').length > 30 && (
                  <Text color="gray">... ({detail.ocrText.split('\n').length - 30} more lines)</Text>
                )}
              </Box>
            )}
          </Box>
        </Box>
      );
    }
  }

  // List view
  return (
    <Box flexDirection="column">
      <Text bold underline>Documents</Text>
      <Text color="yellow">j/k or ↑↓ navigate | Enter details | r refresh</Text>

      {queue && queue.isProcessing && (
        <Text color="magenta">Queue: {queue.queueLength} pending | Processing...</Text>
      )}
      {queue && !queue.isProcessing && queue.queueLength > 0 && (
        <Text color="gray">Queue: {queue.queueLength} pending</Text>
      )}

      <Box marginTop={1} flexDirection="column">
        {/* Header */}
        <Box>
          <Box width={3}><Text bold color="gray"> </Text></Box>
          <Box width={26}><Text bold color="gray">Name</Text></Box>
          <Box width={14}><Text bold color="gray">Category</Text></Box>
          <Box width={12}><Text bold color="gray">Status</Text></Box>
          <Box width={10}><Text bold color="gray">Size</Text></Box>
          <Box width={14}><Text bold color="gray">Date</Text></Box>
        </Box>

        {documents.length === 0 ? (
          <Box marginTop={1}>
            <Text color="gray">No documents found.</Text>
          </Box>
        ) : (
          documents.map((doc, i) => {
            const statusColor = doc.status === 'processed' ? 'green' : doc.status === 'error' ? 'red' : 'yellow';
            return (
              <Box key={doc.id}>
                <Box width={3}>
                  <Text color={i === selected ? 'cyan' : undefined}>
                    {i === selected ? '▸ ' : '  '}
                  </Text>
                </Box>
                <Box width={26}>
                  <Text color={i === selected ? 'cyan' : 'white'} bold={i === selected}>
                    {doc.originalName.slice(0, 24)}
                  </Text>
                </Box>
                <Box width={14}>
                  <Text color={i === selected ? 'cyan' : 'gray'}>
                    {(doc.category || 'none').slice(0, 12)}
                  </Text>
                </Box>
                <Box width={12}>
                  <Text color={i === selected ? 'cyan' : statusColor}>
                    {doc.status.slice(0, 10)}
                  </Text>
                </Box>
                <Box width={10}>
                  <Text color={i === selected ? 'cyan' : 'gray'}>
                    {formatSize(doc.size)}
                  </Text>
                </Box>
                <Box width={14}>
                  <Text color={i === selected ? 'cyan' : 'gray'}>
                    {formatDate(doc.createdAt)}
                  </Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
