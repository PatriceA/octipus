/**
 * Interactive answers on the server: turn the `octi-ui` fences of a root
 * agent's reply into stored blocks and marker lines (docs/plans/inline-ui-spec.md).
 *
 * - `checkInlineUiReply` lists what is wrong with the fences of a draft reply,
 *   for the worker's one repair round (G3: the model hears it in the same turn).
 * - `storeInlineUiBlocks` stores each acceptable block and replaces its fence
 *   with `[[octi-ui:<id>|<title>]]`; a block that cannot be shown becomes a
 *   visible notice instead (fail loud). Idempotent: a reply that already holds
 *   markers and no fences comes back unchanged.
 * - `stubInlineUiFences` replaces fences with a plain line, for history copies
 *   that must not carry the source (spec D12).
 */
import { transform } from 'esbuild';
import { inlineUiRepository } from '@/db/repositories/inline-ui-repository';
import {
  describeInlineUiIssues,
  findInlineUiFences,
  hasInlineUiFence,
  INLINE_UI_LIMITS,
  inlineUiFallbackLine,
  inlineUiMarker,
  type InlineUiFence,
  type InlineUiIssue,
  lintInlineUi,
  replaceInlineUiFences,
  splitInlineUiBody,
} from '@/shared/inline-ui';
import { getFlowLabel } from '@/security/flow-guard';
import { isRealUserId } from '@/security/principal';
import { getRunId } from '@/core/run-context';
import { coreLogger } from '@/utils/logger';

/** A JavaScript syntax error as a lint issue, or null. Server only (esbuild). */
export async function scriptSyntaxIssue(js: string): Promise<InlineUiIssue | null> {
  if (!js.trim()) return null;
  try {
    await transform(js, { loader: 'js', format: 'iife', logLevel: 'silent' });
    return null;
  } catch (err) {
    const first = (err as { errors?: Array<{ text: string; location?: { line: number } | null }> }).errors?.[0];
    const where = first?.location ? ` (script line ${first.location.line})` : '';
    return { code: 'script-syntax', severity: 'fatal', message: `the script does not parse${where}: ${first?.text ?? 'syntax error'}` };
  }
}

export interface InlineUiFenceReport {
  fence: InlineUiFence;
  issues: InlineUiIssue[];
}

/** Lint every fence of a reply, script syntax included. */
export async function lintInlineUiFences(text: string): Promise<InlineUiFenceReport[]> {
  if (!hasInlineUiFence(text)) return [];
  const reports: InlineUiFenceReport[] = [];
  const fences = findInlineUiFences(text);
  for (const [index, fence] of fences.entries()) {
    const parts = splitInlineUiBody(fence.body);
    const issues = lintInlineUi(parts, { closed: fence.closed });
    const syntax = parts.issues.includes('unclosed-script') ? null : await scriptSyntaxIssue(parts.js);
    if (syntax) issues.push(syntax);
    if (index >= INLINE_UI_LIMITS.blocksPerReply) {
      issues.push({ code: 'too-many', severity: 'fatal', message: `a reply may carry at most ${INLINE_UI_LIMITS.blocksPerReply} interactive answers` });
    }
    reports.push({ fence, issues });
  }
  return reports;
}

/**
 * The repair message for a draft reply whose fences have problems, or null
 * when every fence is fine. Fed back to the model once (agent-worker.ts).
 */
export async function inlineUiRepairMessage(text: string): Promise<string | null> {
  const reports = (await lintInlineUiFences(text)).filter((r) => r.issues.length > 0);
  if (reports.length === 0) return null;
  const parts = reports.map((r) => `Interactive answer "${r.fence.title}":\n${describeInlineUiIssues(r.issues)}`);
  return `SYSTEM: Your reply's interactive answer cannot be shown as written.\n${parts.join('\n')}\n`
    + 'Write your whole reply again with the corrected octi-ui block (keep the rest of the answer). If it cannot be fixed, answer without it.';
}

export interface InlineUiStoreContext {
  sessionId: string;
  agentId?: string;
  /** Who asked: the room requester, or the chat's owner. */
  requesterId?: string;
  /** The session may not store content outside its own rows (a remote-space session). */
  contentStorageOff: boolean;
}

export interface InlineUiExtraction {
  text: string;
  stored: string[];
  refused: number;
}

function notice(title: string, issues: InlineUiIssue[]): string {
  const reason = issues.find((i) => i.severity === 'fatal')?.message ?? issues[0]?.message ?? 'it could not be stored';
  return `> ⚠ Interactive answer “${title}” could not be shown: ${reason}.`;
}

/**
 * Store the fences of a root agent's final reply and return the reply with
 * marker lines (or notices) in their place.
 */
export async function storeInlineUiBlocks(text: string, ctx: InlineUiStoreContext): Promise<InlineUiExtraction> {
  if (!hasInlineUiFence(text)) return { text, stored: [], refused: 0 };
  if (ctx.contentStorageOff) {
    // Nothing of this session may be copied outside its rows: say so in place.
    return { text: replaceInlineUiFences(text, (f) => `> Interactive answer “${f.title}” is not kept in this conversation.`), stored: [], refused: 0 };
  }
  const reports = await lintInlineUiFences(text);
  const label = getFlowLabel(ctx.sessionId);
  const tainted = label.suspicious || label.private || label.secret;
  const risk: 'normal' | 'high' = label.secret || (label.private && label.suspicious) ? 'high' : 'normal';
  const runId = getRunId() ?? 'run_unknown';
  let room = INLINE_UI_LIMITS.blocksPerSession - await inlineUiRepository.countForSession(ctx.sessionId);
  const replacements: string[] = [];
  const stored: string[] = [];
  let refused = 0;
  for (const { fence, issues } of reports) {
    const fatal = issues.filter((i) => i.severity === 'fatal');
    if (fatal.length > 0 || room <= 0) {
      const why = room <= 0
        ? [{ code: 'session-full', severity: 'fatal' as const, message: `this conversation already holds ${INLINE_UI_LIMITS.blocksPerSession} interactive answers` }]
        : fatal;
      replacements.push(notice(fence.title, why));
      refused++;
      coreLogger.warn({ sessionId: ctx.sessionId, runId, title: fence.title, codes: why.map((i) => i.code) }, 'Interactive answer refused');
      continue;
    }
    const parts = splitInlineUiBody(fence.body);
    const row = await inlineUiRepository.create({
      sessionId: ctx.sessionId,
      runId,
      agentId: ctx.agentId ?? null,
      requesterId: isRealUserId(ctx.requesterId) ? ctx.requesterId : null,
      title: fence.title,
      heightHint: Math.max(INLINE_UI_LIMITS.minHeight, Math.min(fence.height ?? INLINE_UI_LIMITS.defaultHeight, INLINE_UI_LIMITS.maxHeight)),
      css: parts.css,
      html: parts.html,
      js: parts.js,
      scripts: parts.js.trim() !== '',
      tainted,
      risk,
      issues: issues.map((i) => i.code),
    });
    room--;
    stored.push(row.id);
    replacements.push(inlineUiMarker(row.id, fence.title));
    coreLogger.info({
      sessionId: ctx.sessionId, runId, blockId: row.id, mode: row.scripts ? 'scripted' : 'static',
      sizes: { html: parts.html.length, css: parts.css.length, js: parts.js.length }, tainted, risk, issues: row.issues,
    }, 'Interactive answer stored');
  }
  return { text: replaceInlineUiFences(text, (_f, i) => replacements[i] ?? ''), stored, refused };
}

/** Replace every fence with its plain line: a history copy that must not carry the source. */
export function stubInlineUiFences(text: string): string {
  return hasInlineUiFence(text) ? replaceInlineUiFences(text, (f) => inlineUiFallbackLine(f.title)) : text;
}
