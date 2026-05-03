/**
 * <FileTree> — collapsible directory listing for the workspace.
 *
 * Lazy: directories are read on expand (no recursive walk at
 * mount). Uses node:fs synchronously since the TUI is local-first;
 * for remote workspaces a future iteration can hit
 * `/api/me/workspaces/:id/files`.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { bufferStore, layoutStore, workspaceStore } from '../app';
import { useStore } from '../stores/use-store';
import { getTheme } from '../theme';
import { readFileForBuffer } from '../workspace-fs-bridge';

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  expanded: boolean;
  children: Node[] | null;
}

const HIDDEN_PREFIX = ['.git', 'node_modules', '.octipus', 'dist', 'build'];

function listDir(path: string): Node[] {
  let entries: string[] = [];
  try { entries = readdirSync(path); } catch { return []; }
  return entries
    .filter((n) => !HIDDEN_PREFIX.includes(n) && !n.startsWith('.'))
    .map((n) => {
      const full = join(path, n);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { /* ignore */ }
      return { name: n, path: full, isDir, expanded: false, children: null };
    })
    .sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name));
}

export function FileTree({ focused }: { focused: boolean }) {
  const theme = getTheme();
  const root = useStore(workspaceStore, (s) => s.projectRoot);
  const [tree, setTree] = useState<Node[]>(() => listDir(root));
  const [cursor, setCursor] = useState(0);

  // Flatten visible rows with their depth.
  const flat: { node: Node; depth: number }[] = [];
  function walk(nodes: Node[], depth: number) {
    for (const n of nodes) {
      flat.push({ node: n, depth });
      if (n.expanded && n.children) walk(n.children, depth + 1);
    }
  }
  walk(tree, 0);

  const update = (target: Node, patch: Partial<Node>) => {
    const apply = (nodes: Node[]): Node[] =>
      nodes.map((n) => n === target ? { ...n, ...patch } : { ...n, children: n.children ? apply(n.children) : null });
    setTree((t) => apply(t));
  };

  useInput((input, key) => {
    if (!focused) return;
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(flat.length - 1, c + 1)); return; }
    const sel = flat[cursor]?.node;
    if (!sel) return;
    if (key.return || input === ' ') {
      if (sel.isDir) {
        if (!sel.children) sel.children = listDir(sel.path);
        update(sel, { expanded: !sel.expanded });
      } else {
        // Open file in a buffer.
        const text = readFileForBuffer(sel.path);
        if (text !== null) {
          bufferStore.openFile(sel.path, text);
          layoutStore.focus('editor');
        }
      }
    }
  });

  if (flat.length === 0) {
    return <Text color={theme.dim}>(empty)</Text>;
  }

  return (
    <Box flexDirection="column">
      {flat.slice(0, 30).map(({ node, depth }, i) => (
        <Text
          key={node.path}
          color={i === cursor && focused ? theme.accent : theme.fg}
        >
          {' '.repeat(depth * 2)}
          {node.isDir ? (node.expanded ? '▾ ' : '▸ ') : '  '}
          {node.name}
        </Text>
      ))}
      {flat.length > 30 && (
        <Text color={theme.dim}>… {flat.length - 30} more</Text>
      )}
    </Box>
  );
}
