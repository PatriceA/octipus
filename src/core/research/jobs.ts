/**
 * Background research jobs. Research takes seconds-to-minutes, so the route
 * starts a job and the client polls for progress + the finished report (same
 * pattern as the hwfit installer).
 *
 * The job is a `background_jobs` row, not an in-process record: a restart
 * used to empty the map this module kept, so a client polling its job id got
 * a 404 for work that may well have finished. Now the row outlives the
 * process; a run the restart killed reads as `error` with a reason, the boot
 * sweep having marked it (`src/core/jobs/recover.ts`).
 */
import { backgroundUserPrincipal, createTasksFromSource, researchFollowUpTask } from '@/core/tasks/sourced';
import { backgroundJobRepository } from '@/db/repositories/background-job-repository';
import type { BackgroundJob } from '@/db/schema/background-jobs';
import { coreLogger } from '@/utils/logger';
import { persistReport } from './persist';
import { defaultResearchDeps, type ResearchDeps, runResearch } from './service';
import type { ReportDoc, ResearchDepth } from './types';

export interface ResearchJob {
  id: string;
  /** Owner — only this user (or an admin) may poll the job. */
  userId: string;
  question: string;
  depth: ResearchDepth;
  status: 'running' | 'done' | 'error';
  /** Current stage: planning | searching | reading | synthesizing | done. */
  stage: string;
  detail?: string;
  report?: ReportDoc;
  /** Document id of the saved report, once persisted + indexed into the KB. */
  documentId?: string;
  /** To-do created to review the report (source: research), when it succeeded. */
  taskId?: string;
  error?: string;
  startedAt: number;
}

interface ResearchPayload { question: string; depth: ResearchDepth }
interface ResearchResult { report?: ReportDoc; documentId?: string; taskId?: string }

/**
 * The row as the poller has always seen it. `interrupted` is an error from
 * the client's side — the run stopped and will not continue — so it is
 * reported as one, with the sweep's reason.
 */
export function researchJobFromRow(row: BackgroundJob): ResearchJob {
  const payload = row.payload as unknown as ResearchPayload;
  const result = (row.result ?? {}) as ResearchResult;
  const status: ResearchJob['status'] =
    row.status === 'done' ? 'done' : row.status === 'running' || row.status === 'queued' ? 'running' : 'error';
  return {
    id: row.id,
    userId: row.userId,
    question: payload.question,
    depth: payload.depth,
    status,
    stage: row.stage ?? 'planning',
    detail: row.detail ?? undefined,
    report: result.report,
    documentId: result.documentId ?? row.resultRef ?? undefined,
    taskId: result.taskId,
    error: row.error ?? undefined,
    startedAt: (row.startedAt ?? row.createdAt).getTime(),
  };
}

/** Unscoped read — routes go through `scopedRepos(principal).jobs` instead so ownership is enforced. */
export async function getResearchJob(id: string): Promise<ResearchJob | undefined> {
  const row = await backgroundJobRepository.findById(id);
  return row && row.kind === 'research' ? researchJobFromRow(row) : undefined;
}

/**
 * Start a research job and return it once its row exists. `deps` is
 * injectable for tests; production passes the default search/fetch/model
 * deps. The run itself continues in the background and reports through the
 * row; `getResearchJob` / the scoped repo read it back.
 */
export async function startResearch(
  question: string,
  depth: ResearchDepth,
  userId: string,
  deps: ResearchDeps = defaultResearchDeps(userId),
): Promise<ResearchJob> {
  const row = await backgroundJobRepository.create({
    kind: 'research',
    userId,
    title: question,
    payload: { question, depth } satisfies ResearchPayload,
    status: 'running',
    // Research runs on the caller's thread, not through a worker: it starts
    // now, so the row starts as `running` rather than waiting to be claimed.
  });
  const jobId = row.id;

  // Progress writes are chained so they reach the row in the order the run
  // reported them; a lost write costs a stale stage line, nothing more.
  let progressChain: Promise<void> = Promise.resolve();
  const report = (stage: string, detail?: string) => {
    progressChain = progressChain
      .then(() => backgroundJobRepository.progress(jobId, { stage, detail: detail ?? null }))
      .catch((err: unknown) => coreLogger.warn({ jobId, err: (err as Error).message }, 'research: progress write failed'));
  };

  void (async () => {
    try {
      const reportDoc = await runResearch(question, depth, deps, report);
      const result: ResearchResult = { report: reportDoc };
      // Always emit a document and add it to the knowledge base so the report
      // can be referenced later. Fail-soft: a persistence hiccup still returns
      // the report to the client.
      result.documentId = (await persistReport(reportDoc, userId)) ?? undefined;
      // A report nobody is reminded to read is a report nobody acts on: one
      // follow-up to-do per run, pointing at the saved document. Fail-soft
      // like persistence — the report is the deliverable, the task is a nudge.
      try {
        const [task] = await createTasksFromSource(
          backgroundUserPrincipal(userId),
          'research',
          [researchFollowUpTask(reportDoc, result.documentId)],
        );
        result.taskId = task?.id;
      } catch (err) {
        coreLogger.warn({ question, err: (err as Error).message }, 'research: report saved but follow-up task failed');
      }
      await progressChain;
      const closed = await backgroundJobRepository.finish(jobId, {
        status: 'done',
        result: result as unknown as Record<string, unknown>,
        resultRef: result.documentId ?? null,
      });
      if (!closed) coreLogger.warn({ jobId }, 'research: job finished but its row was no longer running (swept by a restart?)');
    } catch (err) {
      const message = (err as Error).message;
      coreLogger.error({ question, err: message }, 'research: job failed');
      await progressChain;
      await backgroundJobRepository
        .finish(jobId, { status: 'error', error: message })
        .catch((e: unknown) => coreLogger.error({ jobId, err: (e as Error).message }, 'research: could not record failure'));
    }
  })();

  return researchJobFromRow(row);
}
