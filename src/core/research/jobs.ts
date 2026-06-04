/**
 * Background research jobs. Research takes seconds-to-minutes, so the route
 * starts a job and the client polls for progress + the finished report (same
 * pattern as the hwfit installer).
 */
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
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, ResearchJob>();
/** Keep finished jobs around long enough for the client to poll the result. */
const JOB_TTL_MS = 30 * 60_000;

/** Drop jobs older than the TTL so the Map can't grow unbounded. */
function pruneJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.startedAt < cutoff) jobs.delete(id);
  }
}

export function getResearchJob(id: string): ResearchJob | undefined {
  return jobs.get(id);
}

/**
 * Start a research job and return it immediately. `deps` is injectable for
 * tests; production passes the default search/fetch/model deps.
 */
export function startResearch(
  question: string,
  depth: ResearchDepth,
  userId: string,
  deps: ResearchDeps = defaultResearchDeps(userId),
): ResearchJob {
  pruneJobs();
  const job: ResearchJob = {
    id: globalThis.crypto.randomUUID(),
    userId,
    question,
    depth,
    status: 'running',
    stage: 'planning',
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);

  void (async () => {
    try {
      const report = await runResearch(question, depth, deps, (stage, detail) => {
        job.stage = stage;
        job.detail = detail;
      });
      job.report = report;
      // Always emit a document and add it to the knowledge base so the report
      // can be referenced later. Fail-soft: a persistence hiccup still returns
      // the report to the client.
      job.documentId = (await persistReport(report, userId)) ?? undefined;
      job.stage = 'done';
      job.status = 'done';
    } catch (err) {
      job.status = 'error';
      job.error = (err as Error).message;
      coreLogger.error({ question, err: job.error }, 'research: job failed');
    }
  })();

  return job;
}
