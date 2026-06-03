/**
 * Background research jobs. Research takes seconds-to-minutes, so the route
 * starts a job and the client polls for progress + the finished report (same
 * pattern as the hwfit installer).
 */
import { coreLogger } from '@/utils/logger';
import { defaultResearchDeps, type ResearchDeps, runResearch } from './service';
import type { ReportDoc, ResearchDepth } from './types';

export interface ResearchJob {
  id: string;
  question: string;
  depth: ResearchDepth;
  status: 'running' | 'done' | 'error';
  /** Current stage: planning | searching | reading | synthesizing | done. */
  stage: string;
  detail?: string;
  report?: ReportDoc;
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, ResearchJob>();

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
  const job: ResearchJob = {
    id: globalThis.crypto.randomUUID(),
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
