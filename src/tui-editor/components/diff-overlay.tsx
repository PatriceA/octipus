/**
 * <DiffOverlay> — agent has proposed an edit to a buffer.
 *
 * Shows a unified diff against the current buffer text and accepts
 * one of:
 *   `a` / Ctrl+]  — accept the edit; replace the buffer's text and
 *                  release the agent lock.
 *   `r` / Ctrl+[  — reject the edit; release the lock without changes.
 *
 * Wired into Phase 4's agent-action interceptor: when the agent
 * emits a write tool call against a path the user has open, the
 * interceptor opens a diff overlay against the proposed text.
 */
import { Box, Text, useInput } from 'ink';
import { bufferStore } from '../app';
import { diffLines, diffStats } from '../editor/diff';
import { getTheme } from '../theme';

export interface PendingDiff {
  bufferId: string;
  proposed: string;
  /** Source label for the overlay header ("agent → write_file"). */
  source: string;
}

interface Props {
  pending: PendingDiff;
  onClose: () => void;
}

export function DiffOverlay({ pending, onClose }: Props) {
  const theme = getTheme();
  const buf = bufferStore.get().buffers.find((b) => b.id === pending.bufferId);

  useInput((input, key) => {
    if (key.escape || input === 'r' || (key.ctrl && input === '[')) {
      // Reject: release the lock; buffer text unchanged.
      if (buf) bufferStore.setAgentLocked(buf.id, false);
      onClose();
      return;
    }
    if (input === 'a' || (key.ctrl && input === ']')) {
      // Accept: replace text + clear lock.
      if (buf) {
        buf.buffer.setText(pending.proposed);
        bufferStore.markDirty(buf.id, true);
        bufferStore.setAgentLocked(buf.id, false);
      }
      onClose();
    }
  });

  if (!buf) {
    return (
      <Box borderStyle="double" borderColor={theme.error} paddingX={1}>
        <Text color={theme.error}>buffer disappeared — press esc</Text>
      </Box>
    );
  }

  const hunks = diffLines(buf.buffer.text(), pending.proposed);
  const { adds, dels } = diffStats(hunks);
  // Render only the changed regions ± 1 line of context.
  const visible: typeof hunks = [];
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (h.op !== 'keep') {
      visible.push(h);
    } else {
      // Keep one line of context around changes for readability.
      const prev = hunks[i - 1];
      const next = hunks[i + 1];
      if ((prev && prev.op !== 'keep') || (next && next.op !== 'keep')) {
        visible.push(h);
      }
    }
  }
  const max = 25;
  const shown = visible.slice(0, max);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.warn} paddingX={1} width={70}>
      <Box>
        <Text color={theme.warn} bold>⚠ Agent edit: </Text>
        <Text color={theme.fg}>{pending.source}</Text>
        <Text color={theme.dim}>  +{adds} </Text>
        <Text color={theme.diffAdd}>{'+'.repeat(Math.min(adds, 10))}</Text>
        <Text color={theme.dim}> -{dels} </Text>
        <Text color={theme.diffDel}>{'-'.repeat(Math.min(dels, 10))}</Text>
      </Box>
      {shown.map((h, i) => (
        <Box key={i}>
          <Text color={
            h.op === 'add' ? theme.diffAdd
            : h.op === 'del' ? theme.diffDel
            : theme.dim
          }>
            {h.op === 'add' ? '+ ' : h.op === 'del' ? '- ' : '  '}
            {h.text || ' '}
          </Text>
        </Box>
      ))}
      {visible.length > max && (
        <Text color={theme.dim}>… {visible.length - max} more lines</Text>
      )}
      <Text color={theme.dim}>[a] accept · [r] reject · esc to dismiss</Text>
    </Box>
  );
}
