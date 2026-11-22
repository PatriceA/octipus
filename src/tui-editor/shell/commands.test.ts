/** Routing of composer commands: what reaches the file commands, argument intact. */
import { expect, test, vi } from 'vitest';
import type { TUI } from '@/tui-kit';
import { type CommandHost, handleChatSubmit } from './commands';
import type { EditorContext } from './context';

function host() {
  const fileCommands = { newFile: vi.fn(), rename: vi.fn(), deleteCommand: vi.fn(), delete: vi.fn(), revert: vi.fn() };
  const saveAsCommand = vi.fn();
  const sendCommand = vi.fn();
  const ctx = { tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } } as unknown as TUI, pushMessage() {} } as unknown as EditorContext;
  const chat = { messages: { push() {} } };
  const h = { ctx, chat, fileCommands, saveAsCommand, sendCommand } as unknown as CommandHost;
  return { h, fileCommands, saveAsCommand, sendCommand };
}

// `/delete <path>` deleted the active buffer's file whatever was typed; `/rename` and `/save-as` turned
// `a  b.ts` into `a b.ts`, so a path with a run of spaces could not be named.
test('/delete takes its path; /rename and /save-as keep runs of spaces in theirs', () => {
  const { h, fileCommands, saveAsCommand, sendCommand } = host();
  handleChatSubmit(h, '/delete src/old file.ts');
  expect(fileCommands.deleteCommand).toHaveBeenCalledWith('src/old file.ts');
  handleChatSubmit(h, '/delete');
  expect(fileCommands.deleteCommand).toHaveBeenLastCalledWith('');
  handleChatSubmit(h, '/rename notes/two  spaces.md');
  expect(fileCommands.rename).toHaveBeenCalledWith('notes/two  spaces.md');
  handleChatSubmit(h, '/save-as   a\tb  c.txt  ');
  expect(saveAsCommand).toHaveBeenCalledWith('a\tb  c.txt');
  handleChatSubmit(h, '/skills Technical  Writing');
  expect(sendCommand).toHaveBeenCalledWith('skills', 'Technical  Writing');
});
