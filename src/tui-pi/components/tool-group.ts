/**
 * A turn's tool calls as one transcript item, and the reasoning text that
 * came before them.
 *
 * Collapsed, a group is one row: how many calls, how many still run or
 * failed, and how long they took. Expanded (a click on that row, or
 * `app.tools.toggle`), every call shows its arguments and its full output —
 * an edit as a diff.
 *
 * Calls and results are paired by the call id when the gateway sends one
 * (`id` from CLI agents, `toolCallId` on `tool_call_complete`); a native
 * agent announces its calls without one, so a result with no matching id
 * takes the oldest running call of the same tool.
 */
import { displayText, wrapTextWithAnsi } from '@/tui-kit';
import { computeLineDiff } from '@/shared/diff';
import type { ToolEventState } from '../gateway-adapter';
import { chalk, getPalette } from '../theme/defaults';

export interface ToolCallRecord {
  callId?: string;
  /** The tool's own name, for pairing. */
  tool: string;
  /** What to call it: the server's title once known ("Read poem.md"), else the tool name. */
  label: string;
  state: 'running' | 'completed' | 'error';
  preview?: string;
  mcpServer?: string;
  args?: Record<string, unknown>;
  /** The server's one-line summary of the input, when the call came without arguments. */
  input?: string;
  output?: string;
  diff?: string;
  startedAt: number;
  durationMs?: number;
}

export interface ToolGroupItem {
  kind: 'tools';
  calls: ToolCallRecord[];
  expanded: boolean;
}

/** Reasoning the agent wrote before calling tools: kept, dim, folded. */
export interface ThinkingItem {
  kind: 'thinking';
  text: string;
  expanded: boolean;
}

export function newToolGroup(): ToolGroupItem { return { kind: 'tools', calls: [], expanded: false }; }

/** Fold one tool event into the group. */
export function applyToolEvent(group: ToolGroupItem, tool: ToolEventState, now = Date.now()): void {
  if (tool.state === 'pending' || tool.state === 'executing') {
    const known = tool.callId ? group.calls.find(call => call.callId === tool.callId) : undefined;
    if (known) { Object.assign(known, definedOnly({ args: tool.args, preview: tool.preview })); return; }
    group.calls.push({
      callId: tool.callId, tool: tool.toolName ?? tool.name, label: tool.name, state: 'running', preview: tool.preview,
      mcpServer: tool.mcpServer, args: tool.args, diff: tool.diff, startedAt: now,
    });
    return;
  }
  const toolName = tool.toolName ?? tool.name;
  const call = (tool.callId ? group.calls.find(c => c.callId === tool.callId) : undefined)
    ?? group.calls.find(c => c.state === 'running' && !c.callId && c.tool === toolName)
    ?? group.calls.find(c => c.state === 'running' && c.tool === toolName && !tool.callId);
  const target = call ?? (() => {
    const orphan: ToolCallRecord = { callId: tool.callId, tool: toolName, label: tool.name, state: 'running', mcpServer: tool.mcpServer, startedAt: now };
    group.calls.push(orphan);
    return orphan;
  })();
  target.state = tool.state === 'error' ? 'error' : 'completed';
  target.label = tool.title ?? (call ? target.label : tool.name);
  target.durationMs = tool.durationMs ?? (call ? now - call.startedAt : undefined);
  Object.assign(target, definedOnly({ preview: tool.preview, output: tool.output, diff: tool.diff, input: tool.input, callId: tool.callId }));
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The collapsed row's text, without colour: what the group did, in one line. */
export function toolGroupSummary(group: ToolGroupItem): string {
  const running = group.calls.filter(call => call.state === 'running').length;
  const failed = group.calls.filter(call => call.state === 'error').length;
  const total = group.calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
  const names = [...new Set(group.calls.map(call => call.tool))];
  const parts = [`${group.calls.length} tool call${group.calls.length === 1 ? '' : 's'}`];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  if (total > 0) parts.push(formatDuration(total));
  return `${group.expanded ? '▾' : '▸'} ${parts.join(' · ')} — ${names.join(', ')}`;
}

/** Whether `diff` came with the call: computed from an edit's old and new text, or a whole new file. */
export function diffFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const text = (key: string) => (typeof args[key] === 'string' ? args[key] as string : undefined);
  const before = text('old_str') ?? text('old_string');
  const after = text('new_str') ?? text('new_string');
  if (before !== undefined && after !== undefined) return computeLineDiff(before, after, { context: 2, maxPatchLines: 400 }).patch;
  return undefined;
}

/** The rows of a group, rail included (two cells, as every transcript row). */
export function renderToolGroup(group: ToolGroupItem, width: number): string[] {
  const p = getPalette();
  const inner = Math.max(1, width - 2);
  const failed = group.calls.some(call => call.state === 'error');
  const rail = failed ? chalk.hex(p.error)('! ') : chalk.hex(p.dim)('· ');
  const head = displayText(toolGroupSummary(group));
  const rows = wrapTextWithAnsi(head, inner).slice(0, 1).map(line => rail + chalk.hex(failed ? p.error : p.dim)(line));
  if (!group.expanded) return rows;
  const dim = chalk.hex(p.dim);
  const push = (text: string, style: (t: string) => string, indent: string) => {
    for (const line of wrapTextWithAnsi(displayText(text), Math.max(1, inner - indent.length))) rows.push(rail + indent + style(line));
  };
  for (const call of group.calls) {
    const mark = call.state === 'running' ? '…' : call.state === 'error' ? '✗' : '✓';
    const colour = call.state === 'error' ? p.error : call.state === 'running' ? p.warn : p.ok;
    const mcp = call.mcpServer ? ` [mcp:${call.mcpServer}]` : '';
    const took = call.durationMs !== undefined ? ` · ${formatDuration(call.durationMs)}` : call.state === 'running' ? ' · running' : '';
    push(`${mark} ${call.label}${mcp}${took}`, chalk.hex(colour), '');
    const args = argumentText(call);
    if (args) push(args, chalk.hex(p.fg), '    ');
    const diff = call.diff ?? diffFromArgs(call.args);
    if (diff) {
      for (const line of diff.split('\n')) {
        const style = line.startsWith('+') ? chalk.hex(p.ok) : line.startsWith('-') ? chalk.hex(p.error) : dim;
        push(line, style, '    ');
      }
    }
    // An edit's output is its diff, unless it failed: then why.
    if (call.output && (!diff || call.state === 'error')) push(call.output, call.state === 'error' ? chalk.hex(p.error) : dim, '    ');
    else if (!diff && call.preview && call.state !== 'running') push(call.preview, dim, '    ');
  }
  return rows;
}

/** A call's arguments as text: the command or path when that is all there is, the whole object otherwise. */
export function argumentText(call: ToolCallRecord): string | undefined {
  const args = call.args;
  if (!args || !Object.keys(args).length) return call.input;
  const keys = Object.keys(args);
  if (keys.length === 1 && typeof args.command === 'string') return `$ ${args.command}`;
  if (keys.length === 1 && typeof args.path === 'string') return args.path;
  return JSON.stringify(args, null, 2);
}

/** The rows of a thinking item. */
export function renderThinking(item: ThinkingItem, width: number): string[] {
  const p = getPalette();
  const inner = Math.max(1, width - 2);
  const dim = chalk.hex(p.dim);
  const text = displayText(item.text).trim();
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const head = `${item.expanded ? '▾' : '▸'} Thinking · ${lines.length} line${lines.length === 1 ? '' : 's'}${item.expanded ? '' : ` — ${first}`}`;
  const rows = wrapTextWithAnsi(head, inner).slice(0, 1).map(line => dim(`· ${chalk.italic(line)}`));
  if (!item.expanded) return rows;
  for (const line of wrapTextWithAnsi(text, Math.max(1, inner - 2))) rows.push(dim(`·   ${chalk.italic(line)}`));
  return rows;
}

/** One line per call, for `/export`, `/copy transcript` and the exit summary. */
export function toolGroupText(group: ToolGroupItem): string {
  return group.calls.map(call => {
    const mark = call.state === 'running' ? '…' : call.state === 'error' ? '✗' : '✓';
    const args = argumentText(call);
    return `${mark} ${call.label}${args && !args.includes('\n') ? ` → ${args}` : ''}${call.durationMs !== undefined ? ` (${formatDuration(call.durationMs)})` : ''}`;
  }).join('\n');
}
