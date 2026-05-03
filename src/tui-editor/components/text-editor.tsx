/**
 * <TextEditor> — multi-line text editor pane.
 *
 * Renders the active buffer with line numbers + cursor + simple
 * syntax highlighting. Routes keyboard input directly to the
 * `Buffer` mutation methods.
 *
 * Scrolling: tracks a `scrollLine` offset locally so the cursor
 * stays in view; computes a window of visible lines from the
 * buffer's `version` (for memoization-friendly re-renders).
 */
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { bufferStore, layoutStore } from '../app';
import { highlightLine, tokenColor } from '../editor/highlight';
import { useStore } from '../stores/use-store';
import { getTheme } from '../theme';
import { writeFileForBuffer } from '../workspace-fs-bridge';

interface Props {
  focused: boolean;
  height: number;
}

export function TextEditor({ focused, height }: Props) {
  const theme = getTheme();
  const active = useStore(bufferStore, (s) => s.buffers.find((b) => b.id === s.activeId) ?? null);
  const [scrollLine, setScrollLine] = useState(0);
  // Track cursor changes by version so the rendered cursor stays in sync.
  const version = active?.buffer.version ?? 0;

  // Auto-scroll when cursor leaves the window.
  useEffect(() => {
    if (!active) return;
    const cur = active.buffer.getCursor();
    if (cur.line < scrollLine) setScrollLine(cur.line);
    else if (cur.line >= scrollLine + height) setScrollLine(cur.line - height + 1);
  }, [active, version, height, scrollLine]);

  useInput((input, key) => {
    if (!focused || !active) return;
    if (active.agentLocked) return; // diff overlay handles input

    const buf = active.buffer;

    // Cursor motion
    if (key.leftArrow) { buf.moveCursor(0, -1, key.shift); bufferStore.markDirty(active.id, active.dirty); return; }
    if (key.rightArrow) { buf.moveCursor(0, 1, key.shift); return; }
    if (key.upArrow) { buf.moveCursor(-1, 0, key.shift); return; }
    if (key.downArrow) { buf.moveCursor(1, 0, key.shift); return; }

    // Word + line motion
    if (key.ctrl && input === 'a') { buf.moveLineStart(key.shift); return; }
    if (key.ctrl && input === 'e') { buf.moveLineEnd(key.shift); return; }
    if (key.meta && key.leftArrow) { buf.moveWordLeft(key.shift); return; }
    if (key.meta && key.rightArrow) { buf.moveWordRight(key.shift); return; }

    // Save (Ctrl+S)
    if (key.ctrl && input === 's') {
      if (active.path) {
        const ok = writeFileForBuffer(active.path, buf.text());
        if (ok) bufferStore.markDirty(active.id, false);
      }
      return;
    }

    // Undo / redo
    if (key.ctrl && input === 'z') { buf.undo(); bufferStore.markDirty(active.id, true); return; }
    if (key.ctrl && input === 'y') { buf.redo(); bufferStore.markDirty(active.id, true); return; }

    // Goto / find / replace overlays
    if (key.ctrl && input === 'g') { layoutStore.openOverlay({ kind: 'goto-line' }); return; }
    if (key.ctrl && input === 'f') { layoutStore.openOverlay({ kind: 'find' }); return; }
    if (key.ctrl && input === 'h') { layoutStore.openOverlay({ kind: 'replace' }); return; }

    // Editing
    if (key.delete || key.backspace) { buf.deleteBackward(); bufferStore.markDirty(active.id, true); return; }
    if (key.return) { buf.insert('\n'); bufferStore.markDirty(active.id, true); return; }
    if (key.tab) { buf.insert('  '); bufferStore.markDirty(active.id, true); return; }
    if (input && !key.ctrl && !key.meta) {
      buf.insert(input);
      bufferStore.markDirty(active.id, true);
      return;
    }
  });

  if (!active) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.dim}>  No buffer open. Ctrl+O to open a file, Ctrl+P for commands.</Text>
      </Box>
    );
  }

  const lines = active.buffer.getLines();
  const cur = active.buffer.getCursor();
  const visible = lines.slice(scrollLine, scrollLine + height);
  const gutterW = String(lines.length).length;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((line, i) => {
        const lineNo = scrollLine + i;
        const isCurLine = lineNo === cur.line;
        const tokens = highlightLine(line, active.language);
        return (
          <Box key={lineNo}>
            <Text color={isCurLine ? theme.lineNumberCurrent : theme.lineNumber}>
              {String(lineNo + 1).padStart(gutterW, ' ')}{' '}
            </Text>
            {/* Render highlighted tokens with cursor marker on current line. */}
            {isCurLine ? (
              <RenderLineWithCursor tokens={tokens} cursorCol={cur.col} cursorColor={theme.cursor} />
            ) : (
              tokens.map((t, j) => (
                <Text key={j} color={tokenColor(t.kind)}>{t.text}</Text>
              ))
            )}
          </Box>
        );
      })}
      {visible.length < height && Array.from({ length: height - visible.length }).map((_, i) => (
        <Box key={`pad${i}`}><Text color={theme.dim}>{' '.repeat(gutterW)}  ~</Text></Box>
      ))}
    </Box>
  );
}

interface CursorLineProps {
  tokens: { text: string; kind: import('../editor/highlight').TokenKind }[];
  cursorCol: number;
  cursorColor: string;
}

function RenderLineWithCursor({ tokens, cursorCol, cursorColor }: CursorLineProps) {
  // Walk the tokens, splitting the one that contains `cursorCol` and
  // rendering an inverted single-char block at that position.
  let acc = 0;
  const out: React.ReactNode[] = [];
  let placedCursor = false;
  for (let ti = 0; ti < tokens.length; ti++) {
    const t = tokens[ti];
    const start = acc;
    const end = acc + t.text.length;
    if (!placedCursor && cursorCol >= start && cursorCol < end) {
      const before = t.text.slice(0, cursorCol - start);
      const at = t.text[cursorCol - start];
      const after = t.text.slice(cursorCol - start + 1);
      if (before) out.push(<Text key={`${ti}a`} color={tokenColor(t.kind)}>{before}</Text>);
      out.push(<Text key={`${ti}b`} backgroundColor={cursorColor} color="black">{at}</Text>);
      if (after) out.push(<Text key={`${ti}c`} color={tokenColor(t.kind)}>{after}</Text>);
      placedCursor = true;
    } else {
      out.push(<Text key={ti} color={tokenColor(t.kind)}>{t.text}</Text>);
    }
    acc = end;
  }
  if (!placedCursor) {
    // Cursor at end of line — render a trailing block.
    out.push(<Text key="end" backgroundColor={cursorColor} color="black"> </Text>);
  }
  return <>{out}</>;
}
