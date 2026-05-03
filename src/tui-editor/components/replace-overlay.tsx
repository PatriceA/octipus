/**
 * <ReplaceOverlay> — Ctrl+H find + replace all.
 *
 * Two inputs (find / replace), Enter replaces all in the active
 * buffer. Esc closes.
 */
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { bufferStore } from '../app';
import { replaceAll } from '../editor/search';
import { getTheme } from '../theme';

interface Props { onClose: () => void; }

export function ReplaceOverlay({ onClose }: Props) {
  const theme = getTheme();
  const [field, setField] = useState<'find' | 'replace'>('find');
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [lastCount, setLastCount] = useState<number | null>(null);

  useInput((_, key) => {
    if (key.escape) onClose();
    if (key.tab) setField((f) => (f === 'find' ? 'replace' : 'find'));
  });

  const submit = () => {
    if (field === 'find') { setField('replace'); return; }
    const a = bufferStore.active();
    if (a && find) {
      const n = replaceAll(a.buffer, find, repl);
      setLastCount(n);
      bufferStore.markDirty(a.id, true);
    }
  };

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.borderFocus} paddingX={1} width={60}>
      <Box>
        <Text color={field === 'find' ? theme.accent : theme.dim}>find:    </Text>
        {field === 'find' ? (
          <TextInput value={find} onChange={setFind} onSubmit={submit} />
        ) : (
          <Text color={theme.fg}>{find}</Text>
        )}
      </Box>
      <Box>
        <Text color={field === 'replace' ? theme.accent : theme.dim}>replace: </Text>
        {field === 'replace' ? (
          <TextInput value={repl} onChange={setRepl} onSubmit={submit} />
        ) : (
          <Text color={theme.fg}>{repl}</Text>
        )}
      </Box>
      <Text color={theme.dim}>tab to switch · enter to {field === 'find' ? 'next field' : 'replace all'}</Text>
      {lastCount !== null && (
        <Text color={theme.ok}>replaced {lastCount} occurrence{lastCount === 1 ? '' : 's'}</Text>
      )}
    </Box>
  );
}
