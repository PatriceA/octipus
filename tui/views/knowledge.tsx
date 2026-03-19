import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface KnowledgeEntry {
  id: string;
  sourceType: string;
  sourceId: string;
  abstract: string | null;
  content?: string;
  similarity?: number;
  metadata: { filePath?: string; chunkIndex?: number; totalChunks?: number };
  createdAt?: string;
}

type Mode = 'list' | 'detail' | 'search';
type SearchMode = 'hybrid' | 'semantic' | 'keyword';

const SEARCH_MODES: SearchMode[] = ['hybrid', 'semantic', 'keyword'];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

export function KnowledgeView() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [detail, setDetail] = useState<KnowledgeEntry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('hybrid');
  const [searchModeIndex, setSearchModeIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<KnowledgeEntry[] | null>(null);
  const [searching, setSearching] = useState(false);

  const fetchEntries = async () => {
    try {
      const data = await api.get<{ entries: KnowledgeEntry[]; total: number }>('/knowledge');
      setEntries(data?.entries || []);
      setTotal(data?.total || 0);
      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  const fetchDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const data = await api.get<KnowledgeEntry>(`/knowledge/${id}`);
      setDetail(data);
      setDetailLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setDetailLoading(false);
    }
  };

  const executeSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await api.post<{ results: KnowledgeEntry[] }>('/knowledge/search', {
        query: searchQuery.trim(),
        mode: searchMode,
        limit: 10,
      });
      setSearchResults(data?.results || []);
      setSelected(0);
      setSearching(false);
    } catch (err) {
      setError((err as Error).message);
      setSearching(false);
    }
  };

  useEffect(() => {
    fetchEntries();
  }, []);

  const displayEntries = searchResults !== null ? searchResults : entries;

  useInput((input, key) => {
    // Detail mode
    if (mode === 'detail') {
      if (key.escape) {
        setMode(searchResults !== null ? 'search' : 'list');
        setDetail(null);
      }
      return;
    }

    // Search mode input handling
    if (mode === 'search') {
      if (key.escape) {
        setMode('list');
        setSearchQuery('');
        setSearchResults(null);
        setSelected(0);
        return;
      }

      if (key.tab) {
        const nextIndex = (searchModeIndex + 1) % SEARCH_MODES.length;
        setSearchModeIndex(nextIndex);
        setSearchMode(SEARCH_MODES[nextIndex]);
        return;
      }

      if (key.return) {
        if (searchResults !== null && displayEntries[selected]) {
          setMode('detail');
          fetchDetail(displayEntries[selected].id);
        } else {
          executeSearch();
        }
        return;
      }

      if (key.backspace || key.delete) {
        setSearchQuery(s => s.slice(0, -1));
        return;
      }

      // Navigate results if we have them
      if (searchResults !== null) {
        if ((key.upArrow || input === 'k') && selected > 0) {
          setSelected(s => s - 1);
          return;
        }
        if ((key.downArrow || input === 'j') && selected < displayEntries.length - 1) {
          setSelected(s => s + 1);
          return;
        }
      }

      // Append printable characters to search query
      if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        setSearchQuery(s => s + input);
      }
      return;
    }

    // List mode navigation
    if ((key.upArrow || input === 'k') && selected > 0) setSelected(s => s - 1);
    if ((key.downArrow || input === 'j') && selected < displayEntries.length - 1) setSelected(s => s + 1);

    if (key.return && displayEntries[selected]) {
      setMode('detail');
      fetchDetail(displayEntries[selected].id);
    }

    if (input === '/') {
      setMode('search');
      setSearchQuery('');
      setSearchResults(null);
    }

    if (input === 'r') {
      setLoading(true);
      setSearchResults(null);
      setSelected(0);
      fetchEntries();
    }
  });

  if (loading) {
    return <Text color="yellow">Loading knowledge entries...</Text>;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  // Detail view
  if (mode === 'detail') {
    if (detailLoading) {
      return (
        <Box flexDirection="column">
          <Text bold underline>Knowledge</Text>
          <Text color="yellow">Loading entry details...</Text>
        </Box>
      );
    }

    if (detail) {
      const contentLines = detail.content ? detail.content.split('\n').slice(0, 40) : [];
      const totalLines = detail.content ? detail.content.split('\n').length : 0;
      return (
        <Box flexDirection="column">
          <Text bold underline>Knowledge</Text>
          <Text color="gray">ESC to go back</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">Source: {detail.sourceType} | ID: {detail.sourceId}</Text>
            {detail.metadata?.filePath && (
              <Text color="gray">Path: {detail.metadata.filePath}</Text>
            )}
            {detail.metadata?.chunkIndex !== undefined && (
              <Text color="gray">Chunk: {detail.metadata.chunkIndex + 1} / {detail.metadata.totalChunks || '?'}</Text>
            )}
            {detail.similarity !== undefined && (
              <Text color="green">Similarity: {(detail.similarity * 100).toFixed(1)}%</Text>
            )}
            {detail.abstract && (
              <Box marginTop={1} flexDirection="column">
                <Text bold color="yellow">Abstract:</Text>
                <Text color="white">{detail.abstract}</Text>
              </Box>
            )}

            {contentLines.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text bold color="cyan">Content:</Text>
                {contentLines.map((line, i) => (
                  <Text key={i} color="white">{line.length > 120 ? line.slice(0, 120) + '...' : line}</Text>
                ))}
                {totalLines > 40 && (
                  <Text color="gray">... ({totalLines - 40} more lines)</Text>
                )}
              </Box>
            )}
          </Box>
        </Box>
      );
    }
  }

  // List / search view
  return (
    <Box flexDirection="column">
      <Text bold underline>Knowledge</Text>
      {mode === 'search' ? (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan">Search: {searchQuery}█</Text>
            <Text color="gray"> [{searchMode}]</Text>
            <Text color="gray"> (Tab: cycle mode | Enter: search | ESC: cancel)</Text>
          </Box>
          {searching && <Text color="yellow">Searching...</Text>}
        </Box>
      ) : (
        <Text color="yellow">j/k or ↑↓ navigate | Enter details | / search | r refresh</Text>
      )}
      <Text color="gray">Total: {searchResults !== null ? `${searchResults.length} results` : `${total} entries`}</Text>

      <Box marginTop={1} flexDirection="column">
        {/* Header */}
        <Box>
          <Box width={3}><Text bold color="gray"> </Text></Box>
          <Box width={32}><Text bold color="gray">Abstract</Text></Box>
          <Box width={12}><Text bold color="gray">Source</Text></Box>
          <Box width={22}><Text bold color="gray">Path</Text></Box>
          <Box width={14}><Text bold color="gray">Date</Text></Box>
        </Box>

        {displayEntries.length === 0 ? (
          <Box marginTop={1}>
            <Text color="gray">{searchResults !== null ? 'No results found.' : 'No knowledge entries found.'}</Text>
          </Box>
        ) : (
          displayEntries.map((entry, i) => {
            const abstractText = (entry.abstract || 'No abstract').slice(0, 30);
            const pathText = (entry.metadata?.filePath || '').slice(0, 20);
            const hasSimilarity = entry.similarity !== undefined;
            return (
              <Box key={entry.id}>
                <Box width={3}>
                  <Text color={i === selected ? 'cyan' : undefined}>
                    {i === selected ? '▸ ' : '  '}
                  </Text>
                </Box>
                <Box width={32}>
                  <Text color={i === selected ? 'cyan' : 'white'} bold={i === selected}>
                    {abstractText}
                  </Text>
                </Box>
                <Box width={12}>
                  <Text color={i === selected ? 'cyan' : 'gray'}>
                    {entry.sourceType.slice(0, 10)}
                  </Text>
                </Box>
                <Box width={22}>
                  <Text color={i === selected ? 'cyan' : 'gray'}>
                    {pathText}
                  </Text>
                </Box>
                <Box width={14}>
                  <Text color={i === selected ? 'cyan' : 'gray'}>
                    {hasSimilarity
                      ? `${(entry.similarity! * 100).toFixed(0)}% match`
                      : entry.createdAt ? formatDate(entry.createdAt) : ''}
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
