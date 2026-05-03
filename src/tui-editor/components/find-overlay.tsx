/**
 * <FindOverlay> — Ctrl+F live search.
 *
 * Renders a query input + the count of matches in the active
 * buffer. Enter jumps to the next match; Esc closes. The cursor
 * is moved as the user types so the editor pane shows the first
 * hit.
 */
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';
import { bufferStore } from '../app';
import { findAll, type Match } from '../editor/search';
import { getTheme } from '../theme';

interface Props { onClose: () => void; }

export function FindOverlay({ onClose }: Props) {
  const theme = getTheme();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const a = bufferStore.active();
    if (!a) { setMatches([]); return; }
    const m = findAll(a.buffer, query);
    setMatches(m);
    setIdx(0);
    if (m[0]) a.buffer.setCursor({ line: m[0].line, col: m[0].col });
  }, [query]);

  useInput((_, key) => {
    if (key.escape) onClose();
    if (key.return && matches.length > 0) {
      const next = (idx + 1) % matches.length;
      setIdx(next);
      const m = matches[next];
      const a = bufferStore.active();
      if (a) a.buffer.setCursor({ line: m.line, col: m.col });
    }
  });

  return (
    <Box borderStyle="double" borderColor={theme.borderFocus} paddingX={1} width={50}>
      <Text color={theme.dim}>find: </Text>
      <TextInput value={query} onChange={setQuery} onSubmit={() => { /* handled in useInput */ }} />
      <Text color={theme.dim}>  {matches.length === 0 ? '(no match)' : `${idx + 1}/${matches.length}`}</Text>
    </Box>
  );
}
