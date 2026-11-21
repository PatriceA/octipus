/**
 * The email triage training set: what the decision model (Clef) answered per
 * mail, the label it is measured against, the worked examples it is shown,
 * and the per-question confidence thresholds fitted from those labels.
 *
 * Labels come from the owner (review queue) or a reference model (every live
 * triage run, and the bulk labelling run). A user label wins everywhere: it is
 * never overwritten, and triage returns it instead of asking any model.
 */
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type ClefObservation, type EmailTriageLabel, emailTriageLabels, type StoredTriage } from '@/db/schema/email-triage-labels';
import type { EmailProvider, EmailTriage, InboxItem } from './types';

type Priority = EmailTriage['priority'];

/** Default gate until there are enough labels to fit one (the owner's choice, 2026-11-17). */
export const DEFAULT_THRESHOLD = 0.7;
/** Fitted thresholds must keep the accepted answers at least this accurate. */
export const TARGET_ACCURACY = 0.9;
/** Labelled answers a question needs before its threshold is fitted rather than defaulted. */
export const MIN_CALIBRATION = 30;
const SNIPPET_CHARS = 300;
const EXAMPLES = 5;
// ponytail: the big consumer providers only; add one when its mail shows up as misleading examples.
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'aol.com', 'proton.me', 'protonmail.com']);

export interface Thresholds { priority: number; category: number }
export interface QuestionFit { threshold: number; labelled: number; accepted: number; accuracy: number | null; fitted: boolean }

/**
 * Lowest threshold whose accepted answers reach TARGET_ACCURACY, from
 * (confidence, correct) pairs. Too few pairs → the default; enough pairs but
 * no threshold reaches the target → never accept (1.01). Pure.
 */
export function fitThreshold(pairs: Array<{ confidence: number; correct: boolean }>): QuestionFit {
  if (pairs.length < MIN_CALIBRATION) {
    const accepted = pairs.filter(p => p.confidence >= DEFAULT_THRESHOLD);
    return { threshold: DEFAULT_THRESHOLD, labelled: pairs.length, accepted: accepted.length, accuracy: accepted.length ? accepted.filter(p => p.correct).length / accepted.length : null, fitted: false };
  }
  const sorted = [...pairs].sort((a, b) => b.confidence - a.confidence);
  // Walk down from the most confident answer; the last point still at target
  // accuracy (with a minimum sample, so one lucky answer cannot set it) wins.
  let best: QuestionFit = { threshold: 1.01, labelled: pairs.length, accepted: 0, accuracy: null, fitted: true };
  let correct = 0;
  for (let i = 0; i < sorted.length; i++) {
    correct += sorted[i].correct ? 1 : 0;
    const n = i + 1;
    // Ties: only cut between distinct confidences.
    if (i + 1 < sorted.length && sorted[i + 1].confidence === sorted[i].confidence) continue;
    if (n >= 10 && correct / n >= TARGET_ACCURACY) best = { threshold: sorted[i].confidence, labelled: pairs.length, accepted: n, accuracy: correct / n, fitted: true };
  }
  return best;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Owner labels for these mails: triage returns them as they are. */
export async function userLabels(userId: string, provider: EmailProvider, ids: string[]): Promise<Record<string, EmailTriage>> {
  if (!ids.length) return {};
  const rows = await getDb().select().from(emailTriageLabels).where(and(
    eq(emailTriageLabels.userId, userId), eq(emailTriageLabels.provider, provider),
    inArray(emailTriageLabels.messageId, ids), eq(emailTriageLabels.labelSource, 'user'),
  ));
  return Object.fromEntries(rows.map(r => [r.messageId, { priority: r.labelPriority!, category: r.labelCategory! }]));
}

/**
 * Up to five labelled mails like this one, for the decision model: the same
 * sender first, then the same domain; owner labels before model labels.
 * Never the mail itself.
 */
export async function examplesFor(userId: string, item: InboxItem): Promise<Array<{ from: string; subject: string; priority: string; category: string; labelledBy: string }>> {
  const email = item.from.email.toLowerCase();
  const domain = domainOf(email);
  // On a free-mail domain "same domain" says nothing about the sender.
  const sameDomain = FREEMAIL.has(domain) ? sql`false` : sql`split_part(${emailTriageLabels.fromEmail}, '@', 2) = ${domain}`;
  const rows = await getDb().select().from(emailTriageLabels).where(and(
    eq(emailTriageLabels.userId, userId), ne(emailTriageLabels.messageId, item.id), isNotNull(emailTriageLabels.labelSource),
    or(eq(emailTriageLabels.fromEmail, email), sameDomain),
  )).orderBy(
    desc(sql`${emailTriageLabels.fromEmail} = ${email}`),
    desc(sql`${emailTriageLabels.labelSource} = 'user'`),
    desc(emailTriageLabels.labeledAt),
  ).limit(EXAMPLES);
  return rows.map(r => ({ from: r.fromEmail, subject: r.subject, priority: r.labelPriority!, category: r.labelCategory!, labelledBy: r.labelSource === 'user' ? 'owner' : 'model' }));
}

const base = (userId: string, provider: EmailProvider, it: InboxItem) => ({
  userId, provider, messageId: it.id, fromEmail: it.from.email.toLowerCase(),
  subject: it.subject.slice(0, 500), snippet: it.snippet.slice(0, SNIPPET_CHARS),
});

/** Record Clef's answers; a mail seen again gets its latest answer. */
export async function saveObservations(userId: string, provider: EmailProvider, items: InboxItem[], clef: Record<string, ClefObservation>): Promise<void> {
  const rows = items.filter(it => clef[it.id]).map(it => ({ ...base(userId, provider, it), clef: clef[it.id] }));
  if (!rows.length) return;
  await getDb().insert(emailTriageLabels).values(rows).onConflictDoUpdate({
    target: [emailTriageLabels.userId, emailTriageLabels.provider, emailTriageLabels.messageId],
    set: { clef: sql`excluded.clef` },
  });
}

/** Record a reference model's labels under the rubric it was given; an owner label is left alone. */
export async function saveModelLabels(userId: string, provider: EmailProvider, items: InboxItem[], labels: Record<string, EmailTriage>, model: string, rubric: string): Promise<void> {
  const now = new Date();
  const rows = items.filter(it => labels[it.id]).map(it => ({
    ...base(userId, provider, it), labelPriority: labels[it.id].priority, labelCategory: labels[it.id].category,
    labelSource: 'model' as const, labelModel: model, labelRubric: rubric, labeledAt: now,
  }));
  if (!rows.length) return;
  await getDb().insert(emailTriageLabels).values(rows).onConflictDoUpdate({
    target: [emailTriageLabels.userId, emailTriageLabels.provider, emailTriageLabels.messageId],
    set: { labelPriority: sql`excluded.label_priority`, labelCategory: sql`excluded.label_category`, labelSource: sql`excluded.label_source`, labelModel: sql`excluded.label_model`, labelRubric: sql`excluded.label_rubric`, labeledAt: sql`excluded.labeled_at` },
    setWhere: sql`${emailTriageLabels.labelSource} IS DISTINCT FROM 'user'`,
  });
}

/** Record the triage answers a run returned, with the model kind that gave each. */
export async function saveTriageResults(userId: string, provider: EmailProvider, items: InboxItem[], answers: Record<string, EmailTriage>, sourceOf: (id: string) => StoredTriage['source'], rubric?: string): Promise<void> {
  const at = new Date().toISOString();
  const rows = items.filter(it => answers[it.id]).map(it => {
    const { priority, category, reason } = answers[it.id];
    return { ...base(userId, provider, it), triage: { priority, ...(category ? { category } : {}), ...(reason ? { reason: reason.slice(0, 500) } : {}), source: sourceOf(it.id), ...(rubric ? { rubric } : {}), at } };
  });
  if (!rows.length) return;
  await getDb().insert(emailTriageLabels).values(rows).onConflictDoUpdate({
    target: [emailTriageLabels.userId, emailTriageLabels.provider, emailTriageLabels.messageId],
    set: { triage: sql`excluded.triage` },
  });
}

/**
 * The triage to show for these mails without asking a model again: the owner's
 * own label, else the answer the last triage run gave.
 */
export async function storedTriage(userId: string, provider: EmailProvider, ids: string[]): Promise<Record<string, EmailTriage>> {
  if (!ids.length) return {};
  const rows = await getDb().select().from(emailTriageLabels).where(and(
    eq(emailTriageLabels.userId, userId), eq(emailTriageLabels.provider, provider), inArray(emailTriageLabels.messageId, ids),
  ));
  const out: Record<string, EmailTriage> = {};
  for (const r of rows) {
    if (r.labelSource === 'user' && r.labelPriority) out[r.messageId] = { priority: r.labelPriority, ...(r.labelCategory ? { category: r.labelCategory } : {}), source: 'owner' };
    else if (r.triage) out[r.messageId] = { priority: r.triage.priority, ...(r.triage.category ? { category: r.triage.category } : {}), ...(r.triage.reason ? { reason: r.triage.reason } : {}), source: r.triage.source };
  }
  return out;
}

/** The owner's label. Only for a mail triage has already seen (the row holds its sender and subject). */
export async function setUserLabel(userId: string, messageId: string, label: { priority: Priority; category: string }, provider?: EmailProvider): Promise<boolean> {
  const rows = await getDb().update(emailTriageLabels)
    .set({ labelPriority: label.priority, labelCategory: label.category, labelSource: 'user', labelModel: null, labelRubric: null, labeledAt: new Date() })
    .where(and(eq(emailTriageLabels.userId, userId), eq(emailTriageLabels.messageId, messageId), provider ? eq(emailTriageLabels.provider, provider) : undefined))
    .returning({ id: emailTriageLabels.id });
  return rows.length > 0;
}

/**
 * The owner's label for a mail from the inbox list: unlike setUserLabel it
 * also works for a mail no triage run has seen, so a label can be given (or
 * corrected) on any row.
 */
export async function upsertUserLabel(userId: string, provider: EmailProvider, item: InboxItem, label: { priority: Priority; category: string }): Promise<void> {
  const labelled = { labelPriority: label.priority, labelCategory: label.category, labelSource: 'user' as const, labelModel: null, labelRubric: null, labeledAt: new Date() };
  await getDb().insert(emailTriageLabels).values({ ...base(userId, provider, item), ...labelled }).onConflictDoUpdate({
    target: [emailTriageLabels.userId, emailTriageLabels.provider, emailTriageLabels.messageId],
    set: labelled,
  });
}

async function labelledObservations(userId: string, rubric: string): Promise<EmailTriageLabel[]> {
  return getDb().select().from(emailTriageLabels).where(and(
    eq(emailTriageLabels.userId, userId), isNotNull(emailTriageLabels.clef),
    sql`${emailTriageLabels.clef}->>'rubric' = ${rubric}`,
    // A model label given under another rubric answered a different question.
    or(eq(emailTriageLabels.labelSource, 'user'), eq(emailTriageLabels.labelRubric, rubric)),
  ));
}

export function fitAll(rows: Array<Pick<EmailTriageLabel, 'clef' | 'labelPriority' | 'labelCategory'>>): { priority: QuestionFit; category: QuestionFit } {
  return {
    priority: fitThreshold(rows.map(r => ({ confidence: r.clef!.priorityConfidence, correct: r.clef!.priority === r.labelPriority }))),
    category: fitThreshold(rows.map(r => ({ confidence: r.clef!.categoryConfidence, correct: r.clef!.category === r.labelCategory }))),
  };
}

/** The gate for this user's next triage, fitted from their labelled observations. */
export async function thresholdsFor(userId: string, rubric: string): Promise<Thresholds> {
  const fit = fitAll(await labelledObservations(userId, rubric));
  return { priority: fit.priority.threshold, category: fit.category.threshold };
}

export interface ReviewItem {
  messageId: string; from: string; subject: string; snippet: string;
  clef: ClefObservation | null; label: { priority: Priority; category: string; source: 'user' | 'model'; model: string | null } | null;
  /** Clef and the reference model disagree. */
  disagreement: boolean;
}

/**
 * Mails waiting for the owner: everything Clef answered that has no owner
 * label and that the gate would not accept, or where Clef and the reference
 * disagree. Disagreements first, then the least confident.
 */
export async function reviewQueue(userId: string, rubric: string, limit = 50): Promise<{ items: ReviewItem[]; pending: number; stats: { labelledByOwner: number; labelledByModel: number; fit: ReturnType<typeof fitAll> } }> {
  const rows = await getDb().select().from(emailTriageLabels).where(eq(emailTriageLabels.userId, userId));
  const current = rows.filter(r => r.clef?.rubric === rubric);
  const labelled = (r: EmailTriageLabel) => r.labelSource === 'user' || (r.labelSource === 'model' && r.labelRubric === rubric);
  const fit = fitAll(current.filter(labelled));
  const disagrees = (r: EmailTriageLabel) => labelled(r) && !!r.clef && (r.clef.priority !== r.labelPriority || r.clef.category !== r.labelCategory);
  const rejected = (r: EmailTriageLabel) => !r.clef || r.clef.priorityConfidence < fit.priority.threshold || r.clef.categoryConfidence < fit.category.threshold;
  const waiting = current.filter(r => r.labelSource !== 'user' && (disagrees(r) || rejected(r)))
    .sort((a, b) => Number(disagrees(b)) - Number(disagrees(a))
      || Math.min(a.clef!.priorityConfidence, a.clef!.categoryConfidence) - Math.min(b.clef!.priorityConfidence, b.clef!.categoryConfidence));
  return {
    pending: waiting.length,
    items: waiting.slice(0, limit).map(r => ({
      messageId: r.messageId, from: r.fromEmail, subject: r.subject, snippet: r.snippet, clef: r.clef,
      label: labelled(r) ? { priority: r.labelPriority!, category: r.labelCategory!, source: r.labelSource!, model: r.labelModel } : null,
      disagreement: disagrees(r),
    })),
    stats: { labelledByOwner: rows.filter(r => r.labelSource === 'user').length, labelledByModel: rows.filter(r => r.labelSource === 'model' && r.labelRubric === rubric).length, fit },
  };
}
