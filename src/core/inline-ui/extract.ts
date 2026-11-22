/**
 * Interactive answers on the server: turn the `octi-ui` fences of a root
 * agent's reply into stored blocks and marker lines (docs/plans/inline-ui-spec.md).
 * A fence whose body is JSON is a declarative view
 * (docs/plans/inline-ui-views-spec.md), any other body an HTML block; both
 * share the marker, the caps, the repair round and the notices.
 *
 * - `inlineUiRepairMessage` says what is wrong with the fences of a draft reply,
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
import type { NewInlineUiBlock } from '@/db/schema/inline-ui-blocks';
import {
  describeInlineUiIssues,
  findInlineUiFences,
  hasInlineUiFence,
  INLINE_UI_LIMITS,
  inlineUiFallbackLine,
  inlineUiMarker,
  inlineUiMarkerIds,
  type InlineUiFence,
  type InlineUiIssue,
  type InlineUiView,
  isInlineUiViewBody,
  lintInlineUi,
  lintInlineUiView,
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

export type InlineUiFenceReport =
  | { kind: 'html'; fence: InlineUiFence; issues: InlineUiIssue[] }
  /** `view` is the stored form, present when no issue is fatal. */
  | { kind: 'view'; fence: InlineUiFence; issues: InlineUiIssue[]; view?: InlineUiView };

async function lintFence(fence: InlineUiFence): Promise<InlineUiFenceReport> {
  if (isInlineUiViewBody(fence.body)) {
    const { view, issues } = lintInlineUiView(fence.body, { closed: fence.closed });
    return { kind: 'view', fence, issues, ...(view ? { view } : {}) };
  }
  const parts = splitInlineUiBody(fence.body);
  const issues = lintInlineUi(parts, { closed: fence.closed });
  const syntax = parts.issues.includes('unclosed-script') ? null : await scriptSyntaxIssue(parts.js);
  if (syntax) issues.push(syntax);
  return { kind: 'html', fence, issues };
}

/** Lint every fence of a reply: a view's JSON, or an HTML block with its script syntax. */
export async function lintInlineUiFences(text: string): Promise<InlineUiFenceReport[]> {
  if (!hasInlineUiFence(text)) return [];
  const reports: InlineUiFenceReport[] = [];
  const fences = findInlineUiFences(text);
  for (const [index, fence] of fences.entries()) {
    const report = await lintFence(fence);
    if (index >= INLINE_UI_LIMITS.blocksPerReply) {
      report.issues.push({ code: 'too-many', severity: 'fatal', message: `a reply may carry at most ${INLINE_UI_LIMITS.blocksPerReply} interactive answers` });
    }
    reports.push(report);
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

/**
 * Measuring the offer (docs/plans/inline-ui-views-spec.md §8): what the blocks
 * of an offered root turn came to. Root-runner opens a tally when it offers
 * interactive answers; every store pass of that run (the worker's, a CLI
 * root's, the service's) adds to it; the service logs it once, after its own
 * pass, the last before the reply is saved. Bounded: a turn that fails before
 * the log leaves its tally behind, and the oldest go first.
 */
interface OfferTally { setting: string; kinds: Array<'html' | 'view'>; refused: number }
const offeredTurns = new Map<string, OfferTally>();
const OFFER_TALLY_CAP = 1_000;

/** This run's root was offered interactive answers under the setting `setting`. */
export function noteInlineUiOffer(runId: string, setting: string): void {
  if (offeredTurns.has(runId)) return;
  if (offeredTurns.size >= OFFER_TALLY_CAP) offeredTurns.delete(offeredTurns.keys().next().value as string);
  offeredTurns.set(runId, { setting, kinds: [], refused: 0 });
}

/** Log `Interactive answer offer` for an offered run, once; nothing for a run that was not offered. */
export function logInlineUiOffer(runId: string | undefined, sessionId: string): void {
  const tally = runId ? offeredTurns.get(runId) : undefined;
  if (!runId || !tally) return;
  offeredTurns.delete(runId);
  coreLogger.info({
    sessionId, runId, offered: true, used: tally.kinds.length, kinds: [...new Set(tally.kinds)], refused: tally.refused, setting: tally.setting,
  }, 'Interactive answer offer');
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

type BlockContent = Pick<NewInlineUiBlock, 'kind' | 'view' | 'heightHint' | 'css' | 'html' | 'js' | 'scripts'>;

/** What a fence without fatal issues stores, and its sizes for the log. */
function blockContent(report: InlineUiFenceReport): { row: BlockContent; sizes: Record<string, number> } | null {
  const { fence } = report;
  if (report.kind === 'view') {
    // The lint returns the stored form whenever nothing is fatal.
    if (!report.view) return null;
    // A view runs no generated code: nothing in css/html/js, never `scripts`.
    return {
      row: { kind: 'view', view: report.view, heightHint: INLINE_UI_LIMITS.defaultHeight, css: '', html: '', js: '', scripts: false },
      sizes: { view: fence.body.length, components: report.view.components.length },
    };
  }
  const parts = splitInlineUiBody(fence.body);
  return {
    row: {
      kind: 'html',
      heightHint: Math.max(INLINE_UI_LIMITS.minHeight, Math.min(fence.height ?? INLINE_UI_LIMITS.defaultHeight, INLINE_UI_LIMITS.maxHeight)),
      css: parts.css,
      html: parts.html,
      js: parts.js,
      scripts: parts.js.trim() !== '',
    },
    sizes: { html: parts.html.length, css: parts.css.length, js: parts.js.length },
  };
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
  const tally = offeredTurns.get(runId);
  for (const report of reports) {
    const { fence, issues } = report;
    const fatal = issues.filter((i) => i.severity === 'fatal');
    const content = fatal.length === 0 ? blockContent(report) : null;
    if (!content || room <= 0) {
      const why = room <= 0
        ? [{ code: 'session-full', severity: 'fatal' as const, message: `this conversation already holds ${INLINE_UI_LIMITS.blocksPerSession} interactive answers` }]
        : fatal;
      replacements.push(notice(fence.title, why));
      refused++;
      if (tally) tally.refused++;
      coreLogger.warn({ sessionId: ctx.sessionId, runId, title: fence.title, kind: report.kind, codes: why.map((i) => i.code) }, 'Interactive answer refused');
      continue;
    }
    const row = await inlineUiRepository.create({
      ...content.row,
      sessionId: ctx.sessionId,
      runId,
      agentId: ctx.agentId ?? null,
      requesterId: isRealUserId(ctx.requesterId) ? ctx.requesterId : null,
      title: fence.title,
      tainted,
      risk,
      issues: issues.map((i) => i.code),
    });
    room--;
    stored.push(row.id);
    tally?.kinds.push(report.kind);
    replacements.push(inlineUiMarker(row.id, fence.title));
    coreLogger.info({
      sessionId: ctx.sessionId, runId, blockId: row.id, mode: report.kind === 'view' ? 'view' : row.scripts ? 'scripted' : 'static',
      sizes: content.sizes, tainted, risk, issues: row.issues,
    }, 'Interactive answer stored');
  }
  return { text: replaceInlineUiFences(text, (_f, i) => replacements[i] ?? ''), stored, refused };
}

/**
 * The reply as the output guard must read it: with the source of every block
 * it shows. By the time the guard runs, a block is a marker line, which would
 * hide whatever the widget says (a leaked prompt, made-up keys) from a check
 * on the reply alone.
 */
export async function inlineUiGuardText(text: string, sessionId: string): Promise<string> {
  const ids = inlineUiMarkerIds(text);
  if (ids.length === 0) return text;
  const blocks = await inlineUiRepository.getManyInSession(ids, sessionId);
  return [text, ...blocks.map((b) => (b.kind === 'view' ? [b.title, JSON.stringify(b.view)] : [b.title, b.css, b.html, b.js]).join('\n'))].join('\n\n');
}

/** Replace every fence with its plain line: a history copy that must not carry the source. */
export function stubInlineUiFences(text: string): string {
  return hasInlineUiFence(text) ? replaceInlineUiFences(text, (f) => inlineUiFallbackLine(f.title)) : text;
}
