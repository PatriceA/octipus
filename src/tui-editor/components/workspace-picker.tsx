/**
 * <WorkspacePickerOverlay> — pick or refresh the active workspace.
 *
 * Lists workspaces from `workspaceStore.available`. Selection sets
 * the active slug; the gateway client should pick that up via the
 * `X-Octipus-Workspace` header on the next request.
 */
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { workspaceStore } from '../app';
import { useStore } from '../stores/use-store';
import { getTheme } from '../theme';

interface Props { onClose: () => void; }

export function WorkspacePickerOverlay({ onClose }: Props) {
  const theme = getTheme();
  const list = useStore(workspaceStore, (s) => s.available);
  const active = useStore(workspaceStore, (s) => s.activeSlug);
  const [idx, setIdx] = useState(() => Math.max(0, list.findIndex((w) => w.slug === active)));

  useInput((_, key) => {
    if (key.escape) onClose();
    if (key.upArrow) { setIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx((i) => Math.min(list.length - 1, i + 1)); return; }
    if (key.return) {
      if (list[idx]) workspaceStore.setActive(list[idx].slug);
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.borderFocus} paddingX={1} width={50}>
      <Text color={theme.accent} bold>Switch workspace</Text>
      {list.length === 0 ? (
        <Text color={theme.dim}>  no workspaces (multiuser.orgWorkspaces off?)</Text>
      ) : list.map((w, i) => (
        <Text key={w.id} color={i === idx ? theme.accent : theme.fg}>
          {i === idx ? '› ' : '  '}{w.slug}
          {w.isDefault ? ' (default)' : ''}
          {w.slug === active ? ' ✓' : ''}
        </Text>
      ))}
      <Text color={theme.dim}>esc to cancel</Text>
    </Box>
  );
}
