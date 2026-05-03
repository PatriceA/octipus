/**
 * <FilePickerOverlay> — Ctrl+O quick file open.
 *
 * Reuses `file-completer.ts` from the chat TUI for fuzzy path
 * completion. Selecting a path opens it via `bufferStore.openFile`.
 */
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';
import { cancelFileCompletions, getFileCompletions } from '../../tui/file-completer';
import { bufferStore, layoutStore, workspaceStore } from '../app';
import { getTheme } from '../theme';
import { readFileForBuffer } from '../workspace-fs-bridge';

interface Props { onClose: () => void; }

export function FilePickerOverlay({ onClose }: Props) {
  const theme = getTheme();
  const [text, setText] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const root = workspaceStore.get().projectRoot;
    if (text.length < 1) { setResults([]); return; }
    getFileCompletions(text, root, (r) => {
      setResults(r);
      setIdx(0);
    });
    return () => cancelFileCompletions();
  }, [text]);

  useInput((_, key) => {
    if (key.escape) onClose();
    if (key.upArrow) { setIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx((i) => Math.min(results.length - 1, i + 1)); return; }
    if (key.return) {
      const sel = results[idx];
      if (sel) {
        const root = workspaceStore.get().projectRoot;
        const abs = sel.startsWith('/') ? sel : `${root}/${sel}`;
        const data = readFileForBuffer(abs);
        if (data !== null) {
          bufferStore.openFile(abs, data);
          layoutStore.focus('editor');
        }
      }
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.borderFocus} paddingX={1} width={60}>
      <Box>
        <Text color={theme.dim}>file: </Text>
        <TextInput value={text} onChange={setText} onSubmit={() => { /* handled in useInput */ }} />
      </Box>
      {results.slice(0, 10).map((r, i) => (
        <Text key={r} color={i === idx ? theme.accent : theme.fg}>
          {i === idx ? '› ' : '  '}{r}
        </Text>
      ))}
      {results.length === 0 && text.length > 0 && (
        <Text color={theme.dim}>(no matches)</Text>
      )}
    </Box>
  );
}
