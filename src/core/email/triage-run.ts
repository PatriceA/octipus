/**
 * "Triage inbox" as the owner starts it from the Email page: the settings a
 * run uses, a preview of what a run would do and what the models are told,
 * and the run itself as a background job with progress and cancel.
 *
 * The triage logic is in service.ts (triageInbox). Nothing here asks a model
 * except through it.
 */
import { randomUUID } from 'node:crypto';
import { userRepository } from '@/db/repositories/user-repository';
import type { UserPreferences } from '@/db/schema/users';
import { coreLogger } from '@/utils/logger';
import {
  applyCategoryLabels,
  AUTO_ARCHIVE_CATEGORIES,
  autoArchive,
  autoArchiveIds,
  type Categories,
  cleanInstructions,
  getCategories,
  getInbox,
  PRIORITY_RULES,
  rubricKey,
  TriageCancelledError,
  triageInbox,
  triageLlmModel,
  type TriageStage,
} from './service';
import { storedTriage, thresholdsFor } from './triage-labels';
import type { EmailProvider, EmailTriage, InboxItem } from './types';

export const TRIAGE_SCOPES = ['untriaged', 'unread', 'all'] as const;
export type TriageScope = (typeof TRIAGE_SCOPES)[number];

export interface TriageSettings {
  /** Which mails a run takes: not triaged yet, unread, or all of them. */
  scope: TriageScope;
  /** Tag each mail with its category in the mailbox (Gmail label / Outlook category `Octipus/<category>`). */
  applyLabels: boolean;
  /** Archive low-priority mail of `archiveCategories` when a run ends. Off: the run only proposes them. */
  autoArchive: boolean;
  archiveCategories: string[];
  /** The owner's standing instructions to the models. */
  instructions: string;
  /** Start a run with these settings without showing them first. */
  skipDialog: boolean;
}

/** Nothing in the mailbox changes until the owner turns it on. */
export const DEFAULT_TRIAGE_SETTINGS: TriageSettings = {
  scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: [...AUTO_ARCHIVE_CATEGORIES], instructions: '', skipDialog: false,
};

/** Stored settings over the defaults, with archive categories that no longer exist dropped. Pure. */
export function resolveTriageSettings(stored: UserPreferences['emailTriage'] | undefined, categories: Categories): TriageSettings {
  const s = stored ?? {};
  const archive = Array.isArray(s.archiveCategories) ? s.archiveCategories : DEFAULT_TRIAGE_SETTINGS.archiveCategories;
  return {
    scope: (TRIAGE_SCOPES as readonly string[]).includes(s.scope ?? '') ? s.scope as TriageScope : DEFAULT_TRIAGE_SETTINGS.scope,
    applyLabels: s.applyLabels === true,
    autoArchive: s.autoArchive === true,
    archiveCategories: [...new Set(archive.filter((c): c is string => typeof c === 'string' && Object.hasOwn(categories, c)))],
    instructions: cleanInstructions(s.instructions),
    skipDialog: s.skipDialog === true,
  };
}

export async function getTriageSettings(userId: string): Promise<{ settings: TriageSettings; saved: boolean }> {
  const stored = (await userRepository.findById(userId))?.preferences?.emailTriage;
  return { settings: resolveTriageSettings(stored, await getCategories(userId)), saved: !!stored };
}

/** Save a change of some settings; the rest keep their value. */
export async function setTriageSettings(userId: string, patch: Partial<TriageSettings>): Promise<TriageSettings> {
  const user = await userRepository.findById(userId);
  if (!user) throw new Error('User not found');
  const categories = await getCategories(userId);
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const settings = resolveTriageSettings({ ...resolveTriageSettings(user.preferences?.emailTriage, categories), ...given }, categories);
  await userRepository.update(userId, { preferences: { ...(user.preferences ?? {}), emailTriage: settings } });
  return settings;
}

/** The mails of `items` a run with this scope takes. `triaged` holds the ids that already have an answer. Pure. */
export function inScope(items: Array<Pick<InboxItem, 'id' | 'unread'>>, scope: TriageScope, triaged: ReadonlySet<string>): string[] {
  return items.filter(it => (scope === 'all' ? true : scope === 'unread' ? it.unread : !triaged.has(it.id))).map(it => it.id);
}

export interface TriagePreview {
  settings: TriageSettings;
  /** How many of the given mails each scope would take. */
  counts: Record<TriageScope, number>;
  /** Of the given mails: labelled by the owner (kept as they are, no model asked). */
  ownerLabelled: number;
  categories: Categories;
  /** What the models are told, in the words they get. */
  rules: {
    priority: readonly string[];
    /** What of a mail a model sees. */
    sees: string;
    /** The worked examples the decision model is shown. */
    examples: string;
  };
  models: {
    /** The decision model, when one is bound to the `decision` lane. */
    decision: { name: string; local: boolean } | null;
    /** The LLM that answers what the decision model does not, or why none can. */
    llm: { name: string } | { error: string };
  };
  /** Confidence an answer of the decision model needs to be taken, per question. */
  thresholds: { priority: number; category: number } | null;
}

async function decisionModelInfo(): Promise<TriagePreview['models']['decision']> {
  try {
    const { getModelRegistry } = await import('@/models/model-registry');
    const model = await getModelRegistry().getModelForTopic('decision');
    if (!model) return null;
    const { resolveDataPolicy } = await import('@/models/decision');
    const { getConfig } = await import('@/config');
    return { name: model.name, local: resolveDataPolicy(model, getConfig().ollama.url).hosting === 'local' };
  } catch {
    return null;
  }
}

/** What a run over these mails would do, without asking a model. */
export async function triagePreview(userId: string, provider: EmailProvider, items: Array<Pick<InboxItem, 'id' | 'unread'>>): Promise<TriagePreview> {
  const categories = await getCategories(userId);
  const { settings } = await getTriageSettings(userId);
  const known = await storedTriage(userId, provider, items.map(it => it.id)).catch((): Record<string, EmailTriage> => ({}));
  const triaged = new Set(Object.keys(known));
  const decision = await decisionModelInfo();
  const llm = await triageLlmModel(userId).then(m => ({ name: m.modelConfigName }), (err: unknown) => ({ error: String((err as Error)?.message ?? err).slice(0, 300) }));
  return {
    settings,
    counts: { untriaged: inScope(items, 'untriaged', triaged).length, unread: inScope(items, 'unread', triaged).length, all: items.length },
    ownerLabelled: Object.values(known).filter(t => t.source === 'owner').length,
    categories,
    rules: {
      priority: PRIORITY_RULES,
      sees: 'The sender, the subject and the first lines of each mail. Never the full body or attachments.',
      examples: 'For each mail, up to five earlier mails from the same sender (or the same company domain) and how they were labelled. Your own labels come first and outweigh a model\'s.',
    },
    models: { decision, llm },
    thresholds: decision ? await thresholdsFor(userId, rubricKey(categories, settings.instructions)).catch(() => null) : null,
  };
}

export interface TriageRun {
  id: string;
  /** Mails the models are working through (owner-labelled mail is answered at once). */
  total: number;
  done: number;
  stage: 'starting' | TriageStage | 'applying' | 'done';
  startedAt: string;
  finished: boolean;
  cancelled?: boolean;
  error?: string;
  result?: {
    triage: Record<string, EmailTriage>;
    /** Mails tagged with their category in the mailbox. */
    labeled: number;
    labelError?: string;
    /** Archived by this run (auto-archive on). */
    archived: string[];
    /** Low-priority mail of the archive categories the run did NOT archive (auto-archive off): a proposal. */
    archiveProposed: string[];
  };
}

export class TriageBusyError extends Error {}

/** One run per user, in memory: a restart ends it, and the answers given until then are already stored. */
const runs = new Map<string, { run: TriageRun; abort: AbortController }>();
export const currentTriageRun = (userId: string): TriageRun | null => runs.get(userId)?.run ?? null;

export function cancelTriageRun(userId: string): boolean {
  const entry = runs.get(userId);
  if (!entry || entry.run.finished) return false;
  entry.abort.abort();
  return true;
}

export interface TriageRunRequest {
  /** The rows to triage, as the page shows them. */
  items?: InboxItem[];
  /** Instead of `items`: the newest N mails of the inbox, narrowed by the scope. */
  newest?: number;
  scope?: TriageScope;
  /** Called when the run changed the mailbox or the stored triage (a list cache must be dropped). */
  onChanged?: () => void;
}

/** The newest `limit` inbox mails, over as many pages as that takes. */
async function newestInbox(userId: string, limit: number, signal: AbortSignal): Promise<InboxItem[]> {
  const seen = new Set<string>();
  const items: InboxItem[] = [];
  let token: string | undefined;
  do {
    if (signal.aborted) throw new TriageCancelledError();
    const page = await getInbox(userId, Math.min(50, limit - items.length), token);
    for (const it of page.items) if (!seen.has(it.id) && items.length < limit) { seen.add(it.id); items.push(it); }
    token = page.nextPageToken;
    if (!page.items.length) break;
  } while (token && items.length < limit);
  return items;
}

/**
 * Start a triage run in the background with the user's saved settings.
 * Returns at once; follow it with currentTriageRun().
 */
export async function startTriageRun(userId: string, provider: EmailProvider, request: TriageRunRequest): Promise<TriageRun> {
  if (runs.get(userId)?.run.finished === false) throw new TriageBusyError('A triage run is already in progress.');
  // Reserve the slot before any await: two quick clicks must not start two runs.
  const run: TriageRun = { id: randomUUID(), total: request.items?.length ?? request.newest ?? 0, done: 0, stage: 'starting', startedAt: new Date().toISOString(), finished: false };
  const abort = new AbortController();
  runs.set(userId, { run, abort });
  void (async () => {
    const { settings } = await getTriageSettings(userId);
    let items = request.items ?? [];
    if (!request.items) {
      const newest = await newestInbox(userId, Math.min(Math.max(request.newest ?? 30, 1), 500), abort.signal);
      const scope = request.scope ?? settings.scope;
      const triaged = scope === 'untriaged' ? new Set(Object.keys(await storedTriage(userId, provider, newest.map(it => it.id)))) : new Set<string>();
      const keep = new Set(inScope(newest, scope, triaged));
      items = newest.filter(it => keep.has(it.id));
    }
    run.total = items.length;
    const triage = await triageInbox(userId, items, {
      instructions: settings.instructions,
      signal: abort.signal,
      onProgress: ({ stage, done, total }) => { run.stage = stage; run.done = done; run.total = total; },
    });
    run.stage = 'applying';
    // Label first: an archived mail still gets its category label. A label
    // failure (a token without label scope) must not lose the triage.
    let labeled = 0;
    let labelError: string | undefined;
    if (settings.applyLabels) {
      try { labeled = await applyCategoryLabels(userId, provider, triage); }
      catch (err) { labelError = String((err as Error)?.message ?? err).slice(0, 200); }
    }
    const archived = settings.autoArchive ? await autoArchive(userId, provider, triage, settings.archiveCategories) : [];
    const archiveProposed = settings.autoArchive ? [] : autoArchiveIds(triage, settings.archiveCategories);
    run.result = { triage, labeled, ...(labelError ? { labelError } : {}), archived, archiveProposed };
    run.stage = 'done';
  })().catch((err: unknown) => {
    if (err instanceof TriageCancelledError || abort.signal.aborted) { run.cancelled = true; return; }
    // Message only, capped: a provider error can echo the prompt (mail metadata).
    run.error = String((err as Error)?.message ?? err).slice(0, 300);
    coreLogger.warn({ error: run.error.slice(0, 200) }, 'email: triage run failed');
  }).finally(() => {
    run.finished = true;
    request.onChanged?.();
  });
  return run;
}
