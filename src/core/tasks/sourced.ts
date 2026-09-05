/**
 * Tasks created FROM another surface — a Reader action-item list, an email the
 * user wants to act on, a finished Deep Research report. The `tasks` schema
 * has carried `source` / `sourceRef` provenance since it landed, but nothing
 * produced rows with `source !== 'user' | 'agent'`: the enum existed, the
 * producers did not. This module is the one place those producers go
 * through, so provenance is stamped consistently and the UI can link back.
 *
 * Pure builders (`readerItemsToTasks`, `emailToTask`, `researchFollowUpTask`)
 * are separated from the one DB write (`createTasksFromSource`) so the shape
 * of what lands on the to-do list is unit-testable without a database.
 */
import { scopedRepos } from '@/db/repositories/scoped';
import type { Task, TaskSourceRef } from '@/db/schema/tasks';
import type { Principal } from '@/security/principal';

export type TaskSource = 'user' | 'agent' | 'reader' | 'research' | 'email';

export interface SourcedTaskInput {
  title: string;
  notes?: string | null;
  /** 0 none .. 3 high */
  priority?: number;
  category?: string | null;
  dueAt?: Date | null;
  sourceRef?: TaskSourceRef;
}

const TITLE_MAX = 200;
const NOTES_MAX = 4000;

/** Collapse whitespace and cap length so a model-written bullet fits a title. */
export function normalizeTaskTitle(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** Reader `action_items` → one task per bullet, linked back to the article. */
export function readerItemsToTasks(
  items: string[],
  origin: { url?: string; title?: string },
): SourcedTaskInput[] {
  const seen = new Set<string>();
  const out: SourcedTaskInput[] = [];
  for (const raw of items) {
    const title = normalizeTaskTitle(raw);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      notes: origin.url ? `From: ${origin.title ? `${origin.title} — ` : ''}${origin.url}` : null,
      category: 'Reading',
      sourceRef: { url: origin.url, label: origin.title },
    });
  }
  return out;
}

/** The subset of an email the task builder needs (provider-agnostic). */
export interface EmailForTask {
  id: string;
  subject: string;
  from: { name?: string; email: string };
  snippet?: string;
  receivedAt?: string;
  triage?: { priority: 'high' | 'normal' | 'low' } | undefined;
}

/**
 * An email the user wants to act on → one task titled by its subject. Triage
 * priority (when the inbox was triaged) maps onto the task priority so a
 * "high" email lands at the top of the list.
 */
export function emailToTask(message: EmailForTask): SourcedTaskInput {
  const subject = normalizeTaskTitle(message.subject || '(no subject)');
  const sender = message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email;
  const lines = [`From: ${sender}`];
  if (message.receivedAt) lines.push(`Received: ${message.receivedAt}`);
  if (message.snippet?.trim()) lines.push('', message.snippet.trim().slice(0, NOTES_MAX));
  const priority = message.triage?.priority === 'high' ? 3 : message.triage?.priority === 'low' ? 0 : 1;
  return {
    title: subject,
    notes: lines.join('\n'),
    priority,
    category: 'Email',
    sourceRef: { messageId: message.id, label: subject },
  };
}

/**
 * A finished research report → one "review the findings" task pointing at the
 * saved document. One task per run: the report is the deliverable, the task
 * is the reminder that it exists and needs a decision.
 */
export function researchFollowUpTask(
  report: { question: string; sources: ReadonlyArray<unknown> },
  documentId: string | null | undefined,
): SourcedTaskInput {
  const question = normalizeTaskTitle(report.question);
  return {
    title: normalizeTaskTitle(`Review research: ${question}`),
    notes: `Deep Research finished with ${report.sources.length} source${report.sources.length === 1 ? '' : 's'}.${
      documentId ? ' The cited report is saved under Documents (category Research).' : ''
    }`,
    priority: 1,
    category: 'Research',
    sourceRef: { documentId: documentId ?? undefined, label: question },
  };
}

/**
 * A non-admin principal for a background job that has a user id but no
 * request. Mirrors `TasksTool.principalFor`: own rows only, workspace-stamped.
 */
export function backgroundUserPrincipal(userId: string, workspaceId: string | null = null): Principal {
  return {
    kind: 'user',
    userId,
    username: userId,
    isAdmin: false,
    sessionToken: null,
    roles: ['user'],
    workspaceId,
  };
}

/** Persist the built tasks for the principal, stamped with `source`. */
export async function createTasksFromSource(
  principal: Principal,
  source: TaskSource,
  inputs: SourcedTaskInput[],
): Promise<Task[]> {
  const repo = scopedRepos(principal).tasks;
  const created: Task[] = [];
  for (const input of inputs) {
    const title = normalizeTaskTitle(input.title);
    if (!title) continue;
    created.push(
      await repo.create({
        title,
        notes: input.notes ?? null,
        priority: Math.max(0, Math.min(3, Math.trunc(input.priority ?? 0))),
        category: input.category ?? null,
        dueAt: input.dueAt ?? null,
        source,
        sourceRef: input.sourceRef,
      }),
    );
  }
  return created;
}
