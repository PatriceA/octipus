/**
 * The transcript outside the app: `/export` (Markdown), the scrollback dump
 * (plain text) and what is printed on exit (the last exchange and how to
 * resume). Everything printed to the terminal passes through `displayText`,
 * so a reply's escape sequences cannot act on the user's shell; the Markdown
 * file keeps the text as received.
 */
import { displayText } from '@/tui-kit';
import type { Role } from './gateway-adapter';

export interface TranscriptEntry { role: Role; content: string; timestamp: Date }

const LABEL: Record<Role, string> = { user: 'You', assistant: 'Octipus', system: 'Notice' };

/** Lines of the last exchange printed on exit; the rest is in the session, which the resume command reopens. */
export const EXIT_SUMMARY_LINES = 40;

export function defaultExportName(sessionId: string, at: Date): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `octipus-${sessionId.slice(0, 8)}-${stamp}.md`;
}

export function transcriptMarkdown(entries: TranscriptEntry[], sessionId: string, at: Date): string {
  const body = entries.map(entry => {
    const heading = `## ${LABEL[entry.role]} · ${entry.timestamp.toISOString().slice(0, 16).replace('T', ' ')}`;
    const content = entry.role === 'system' ? entry.content.split('\n').map(line => `> ${line}`).join('\n') : entry.content;
    return `${heading}\n\n${content}`;
  });
  return `# Octipus session ${sessionId}\n\nExported ${at.toISOString()}. Resume with \`octi tui --session ${sessionId}\`.\n\n${body.join('\n\n')}\n`;
}

export function transcriptPlainText(entries: TranscriptEntry[]): string {
  return entries.map(entry => `${LABEL[entry.role]}:\n${displayText(entry.content)}`).join('\n\n');
}

function clip(text: string, lines: number): string {
  const all = displayText(text).split('\n');
  return all.length <= lines ? all.join('\n') : `${all.slice(0, lines).join('\n')}\n… ${all.length - lines} more lines`;
}

/**
 * Printed to the normal buffer after the screen is restored: the last thing
 * the user asked and the reply to it, then the command that reopens the
 * session. `sessionId` is null when nothing reached the server, so there is
 * nothing to resume.
 */
export function exitSummary(entries: TranscriptEntry[], sessionId: string | null): string {
  // A slash command (`/quit` itself) is echoed as a user row; the exchange is the last thing asked of the agent.
  const asked = (entry: TranscriptEntry) => entry.role === 'user' && !entry.content.trimStart().startsWith('/');
  const lastUser = entries.findLastIndex(asked);
  const exchange = lastUser < 0 ? [] : entries.slice(lastUser).filter(entry => entry.role === 'assistant' || asked(entry));
  const lines = exchange.map(entry => `${LABEL[entry.role]}:\n${clip(entry.content, EXIT_SUMMARY_LINES)}`);
  if (sessionId) lines.push(`Resume this conversation: octi tui --session ${sessionId}`);
  return lines.join('\n\n');
}
