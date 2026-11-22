import { fitStatusRows } from './status-bar';
import { CURSOR_MARKER, type Component, truncateToWidth, frameRow, type TuiMouseEvent, type TuiMouseEventResult } from '@/tui-kit';
import type { MessagesPane } from './messages-pane';

export function cropComposer(lines: readonly string[], rows: number): string[] {
  if (rows <= 0) return [];
  const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
  const start = cursor < 0 ? 0 : Math.max(0, Math.min(cursor, lines.length - rows));
  return lines.slice(start, start + rows);
}

export interface ChatFooterParts {
  composer: Component;
  activity: Component;
  subagents?: Component & { setMaxRows?: (rows: number) => void };
  status?: Component;
  /** Sticky rows between the transcript and the activity row (queued messages, notices). Lowest priority. */
  sticky?: Component;
}

/** Where the sticky rows ended up in the footer: the first `shown` rows, starting `skipped` rows into the component's own. */
export interface StickyPlacement { shown: number; skipped: number }

/** One rendered row is one terminal row no wider than the screen, whatever a component was handed. */
const frameRows = (lines: readonly string[], width: number): string[] => lines.map(line => truncateToWidth(frameRow(line), width, ''));

/**
 * Everything below the transcript, in a screen `height` rows tall: sticky
 * rows, activity, subagents, composer, status — never more than `height`
 * rows, and `reserve` rows are left for the transcript where possible.
 *
 * Priority when rows are short: the identity/connection status line, then
 * the composer around its cursor (at most 40% of the screen, never below
 * one row), then activity, subagents (up to a third), sticky rows, and the
 * rest of the status rows.
 */
export function renderChatFooter(width: number, height: number, parts: ChatFooterParts, reserve = 0, placement?: StickyPlacement): string[] {
  if (height <= 0 || width <= 0) return [];
  const status = parts.status?.render(width) ?? [];
  // On very short screens keep only the identity/connection line.
  const statusRows = fitStatusRows([...status], height < 8 ? 1 : Math.max(1, Math.floor(height / 3)));
  const remaining = Math.max(0, height - statusRows.length);
  // The identity/connection line wins over the composer when there is room
  // for only one of them.
  const composer = cropComposer(parts.composer.render(width), Math.min(remaining, Math.max(1, Math.ceil(height * 0.4))));
  const activity = parts.activity.render(width).slice(0, Math.max(0, remaining - composer.length));
  const agentBudget = Math.max(0, Math.min(Math.floor(height / 3), remaining - composer.length - activity.length - 2));
  parts.subagents?.setMaxRows?.(agentBudget);
  const agents = (parts.subagents?.render(width) ?? []).slice(0, agentBudget);
  const stickyBudget = Math.max(0, Math.min(Math.floor(height / 4), remaining - composer.length - activity.length - agents.length - reserve));
  // The newest sticky rows (the end of the list) are the ones kept.
  const allSticky = stickyBudget > 0 ? parts.sticky?.render(width) ?? [] : [];
  const sticky = allSticky.slice(-stickyBudget);
  const rows = frameRows([...sticky, ...activity, ...agents, ...composer, ...statusRows], width);
  if (placement) {
    const cut = Math.max(0, rows.length - height);
    placement.shown = Math.max(0, sticky.length - cut);
    placement.skipped = allSticky.length - sticky.length + Math.min(cut, sticky.length);
  }
  return rows.slice(-height);
}

/** The inline frame: exactly `height` rows, the transcript scrolled by the app above the footer. */
export function renderChatFrame(width: number, height: number, parts: ChatFooterParts & { messages: MessagesPane }): string[] {
  if (height <= 0 || width <= 0) return [];
  const footer = renderChatFooter(width, height, parts);
  const headBudget = Math.max(0, height - footer.length);
  parts.messages.setHeight(headBudget);
  const head = parts.messages.render(width);
  return [...frameRows(head, width), ...Array(Math.max(0, headBudget - head.length)).fill(''), ...footer].slice(0, height);
}

/**
 * The footer as a component of the alternate-screen layout: sticky below a
 * scrolling transcript, sized from the screen's height on every frame.
 */
export class ChatFooter implements Component {
  private readonly placement: StickyPlacement = { shown: 0, skipped: 0 };
  constructor(private readonly parts: ChatFooterParts, private readonly screenRows: () => number) {}
  render(width: number): string[] { return renderChatFooter(width, this.screenRows(), this.parts, 1, this.placement); }
  /** Clicks on the sticky rows reach the sticky component, in its own row numbers. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const sticky = this.parts.sticky;
    if (!sticky?.handleMouse || event.y >= this.placement.shown) return undefined;
    return sticky.handleMouse({ ...event, y: event.y + this.placement.skipped });
  }
  invalidate(): void {
    for (const part of [this.parts.composer, this.parts.activity, this.parts.subagents, this.parts.status, this.parts.sticky]) part?.invalidate();
  }
}
