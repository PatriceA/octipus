import { fitStatusRows } from './status-bar';
import { CURSOR_MARKER, type Component, truncateToWidth } from '@mariozechner/pi-tui';
import type { MessagesPane } from './messages-pane';

export function cropComposer(lines: string[], rows: number): string[] {
  if (rows <= 0) return [];
  const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
  const start = cursor < 0 ? 0 : Math.max(0, Math.min(cursor, lines.length - rows));
  return lines.slice(start, start + rows);
}

/** Shared viewport budgeting: the composer cursor survives small windows and large pastes. */
export function renderChatFrame(width: number, height: number, parts: {
  messages: MessagesPane; composer: Component; activity: Component; subagents?: Component & { setMaxRows?: (rows: number) => void }; status?: Component;
}): string[] {
  if (height <= 0 || width <= 0) return [];
  const status = parts.status?.render(width) ?? [];
  // On very short screens keep only the identity/connection line.
  const statusRows = fitStatusRows(status, height < 8 ? 1 : Math.max(1, Math.floor(height / 3)));
  const remaining = Math.max(0, height - statusRows.length);
  // The identity/connection line wins over the composer when there is room
  // for only one of them; the trailing slice below would otherwise drop it.
  const composer = cropComposer(parts.composer.render(width), Math.min(remaining, Math.max(1, Math.ceil(height * 0.4))));
  const activity = parts.activity.render(width).slice(0, Math.max(0, remaining - composer.length));
  const agentBudget = Math.max(0, Math.min(Math.floor(height / 3), remaining - composer.length - activity.length - 2));
  parts.subagents?.setMaxRows?.(agentBudget);
  const agents = (parts.subagents?.render(width) ?? []).slice(0, agentBudget);
  const headBudget = Math.max(0, remaining - composer.length - activity.length - agents.length);
  parts.messages.setHeight(headBudget);
  const head = parts.messages.render(width);
  return [...head, ...Array(Math.max(0, headBudget - head.length)).fill(''), ...activity, ...agents, ...composer, ...statusRows]
    .slice(0, height).map(line => truncateToWidth(line, width, ''));
}
