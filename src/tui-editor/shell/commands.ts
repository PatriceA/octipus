/**
 * What the user asks for: a line submitted in the chat composer (a message,
 * an editor command, a gateway command) and the global hotkeys.
 *
 * The handlers take a `CommandHost`, the actions the app offers, so this
 * module holds the routing and nothing else.
 */
import { getKeybindings, matchesKey } from '@/tui-kit';
import { handleTerminalCommand, wheelDirection } from '@/tui-pi/terminal-actions';
import type { ChatPane } from '../components/chat-pane';
import type { EditorContext } from './context';
import type { EditorOverlays } from './overlay-actions';

export interface CommandHost {
  ctx: EditorContext;
  chat: ChatPane;
  overlays: EditorOverlays;
  /** Clear the info notice in the mode bar; returns whether there was one. */
  clearInfoNotice(): boolean;
  hidePlanDetails(): void;
  setVimMode(on: boolean): void;
  newScratch(): void;
  saveAsCommand(path: string): void;
  reloadKeybindings(): void;
  closeActiveBuffer(): void;
  openSaveAsForActive(): void;
  requestQuit(): void;
  shutdownAndExit(): void;
  sendCommand(name: string, value: string): void;
  sendChat(text: string): void;
}

export function handleChatSubmit(host: CommandHost, rawText: string): void {
  const { ctx, chat } = host;
  if (rawText.trim().startsWith('/') && handleTerminalCommand(rawText, ctx.tui, chat.messages, text => ctx.pushMessage('system', text))) return;
  const text = rawText.trim();
  if (!text) return;
  chat.messages.push({ role: 'user', content: text, timestamp: new Date() });
  ctx.tui.requestRender();

  if (text.startsWith('/')) {
    const parts = text.slice(1).split(/\s+/);
    const name = parts[0];
    const value = parts.slice(1).join(' ').trim();
    // TUI-local commands intercepted before going to the gateway.
    if (name === 'plan-hide') { host.hidePlanDetails(); return; }
    if (name === 'vim') {
      host.setVimMode(value === 'on' ? true : value === 'off' ? false : ctx.layout.get().editorMode !== 'vim');
      return;
    }
    if (name === 'new') { host.newScratch(); return; }
    if (name === 'save-as') { host.saveAsCommand(value); return; }
    if (name === 'quit' || name === 'exit' || name === 'q') { host.shutdownAndExit(); return; }
    if (name === 'keys' || name === 'hotkeys' || name === 'help-keys') { host.overlays.openHotkeys(); return; }
    if (name === 'palette') { host.overlays.openCommandPalette(); return; }
    if (name === 'reload' || name === 'reload-keybindings') { host.reloadKeybindings(); return; }
    host.sendCommand(name, value);
    return;
  }
  host.sendChat(text);
}

export function handleGlobalKey(host: CommandHost, data: string): { consume: true } | undefined {
  const { ctx, chat, overlays } = host;
  const kb = getKeybindings();
  if (host.clearInfoNotice()) ctx.tui.requestRender();
  if (ctx.tui.hasOverlay()) return undefined;
  if (kb.matches(data, 'app.subagents.scrollUp')) { if (chat.subagents.scroll(-1)) { ctx.tui.requestRender(); return { consume: true }; } }
  if (kb.matches(data, 'app.subagents.scrollDown')) { if (chat.subagents.scroll(1)) { ctx.tui.requestRender(); return { consume: true }; } }
  if (kb.matches(data, 'app.subagents.toggle')) { chat.subagents.toggle(); ctx.tui.requestRender(); return { consume: true }; }
  if (ctx.layout.get().focused === 'chat') {
    if (chat.messages.handleScrollInput(data)) { ctx.tui.requestRender(); return { consume: true }; }
  }
  // The tree and the editor do not scroll by wheel yet; a notch must not reach them as input.
  if (wheelDirection(data)) return { consume: true };
  if (kb.matches(data, 'app.tree.toggle'))   { ctx.layout.toggleTree(); return { consume: true }; }
  if (kb.matches(data, 'app.chat.toggle'))   { ctx.layout.toggleChat(); return { consume: true }; }
  if (kb.matches(data, 'app.pane.cycle'))    { ctx.layout.cycleFocus(1); ctx.refocus(); return { consume: true }; }
  if (kb.matches(data, 'app.buffer.next'))   { ctx.buffers.cycle(1); return { consume: true }; }
  if (kb.matches(data, 'app.buffer.prev'))   { ctx.buffers.cycle(-1); return { consume: true }; }
  if (kb.matches(data, 'app.buffer.close'))  { host.closeActiveBuffer(); return { consume: true }; }
  if (kb.matches(data, 'app.file.open'))     { overlays.openFilePicker(); return { consume: true }; }
  if (kb.matches(data, 'app.file.saveAs'))   { host.openSaveAsForActive(); return { consume: true }; }
  if (kb.matches(data, 'app.vim.toggle'))    { host.setVimMode(ctx.layout.get().editorMode !== 'vim'); return { consume: true }; }
  if (kb.matches(data, 'app.find.open'))     { overlays.openFind(); return { consume: true }; }
  if (kb.matches(data, 'app.replace.open'))  { overlays.openReplace(); return { consume: true }; }
  if (kb.matches(data, 'app.workspace.switch')) { void overlays.openWorkspacePicker(); return { consume: true }; }
  if (kb.matches(data, 'app.mcp.list'))      { void overlays.openMCPServerList(); return { consume: true }; }
  if (kb.matches(data, 'app.palette.open'))  { overlays.openCommandPalette(); return { consume: true }; }
  if (kb.matches(data, 'app.help.open'))     { overlays.openHotkeys(); return { consume: true }; }
  if (matchesKey(data, 'ctrl+c')) { host.requestQuit(); return { consume: true }; }
  if (kb.matches(data, 'app.quit'))          { host.shutdownAndExit(); return { consume: true }; }
  return undefined;
}
