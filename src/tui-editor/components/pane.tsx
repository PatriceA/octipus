/**
 * <Pane> — bordered region with a title and a focus indicator.
 *
 * The border colors flip when this pane has focus so the keyboard
 * target is always obvious. Titles render in the top-left corner of
 * the border (Ink doesn't ship a built-in titled border, so we do
 * the simple bracketed approach).
 */
import { Box, Text } from 'ink';
import type React from 'react';
import { getTheme } from '../theme';

interface PaneProps {
  title: string;
  focused: boolean;
  width?: number | string;
  height?: number | string;
  flexGrow?: number;
  children: React.ReactNode;
}

export function Pane({ title, focused, width, height, flexGrow, children }: PaneProps) {
  const theme = getTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? theme.borderFocus : theme.border}
      width={width}
      height={height}
      flexGrow={flexGrow}
      paddingX={1}
    >
      <Box>
        <Text color={focused ? theme.borderFocus : theme.dim}>
          [{title}]
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
