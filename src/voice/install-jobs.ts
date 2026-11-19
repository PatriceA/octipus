/**
 * Installing a local speech engine from the web (Settings → Voice): the
 * download and build run on the server, and the page follows the job. The
 * same installers `octi setup` drives (whisper.ts, provision.ts); a finished
 * install is registered and bound to its lane when that lane is free.
 *
 * One job per engine at a time, kept in memory: a restart loses the log, not
 * the install (the installers skip what is already there).
 */
import { logger } from '@/utils/logger';
import type { SpeechDirection } from './speech-rows';

export type InstallableEngine = 'whisper' | 'fasterwhisper' | 'kokoro';

export interface SpeechInstallJob {
  engine: InstallableEngine;
  /** faster-whisper: the model being downloaded. */
  size?: string;
  stage: 'running' | 'done' | 'error';
  /** The last lines of the installer's output. */
  log: string[];
  error?: string;
  /** The model row the engine was registered as, and whether it took its lane. */
  model?: string;
  bound?: 'primary' | 'already-bound' | 'not-bound';
  startedAt: number;
  finishedAt?: number;
}

const DIRECTION: Record<InstallableEngine, SpeechDirection> = { whisper: 'stt', fasterwhisper: 'stt', kokoro: 'tts' };
const jobs = new Map<InstallableEngine, SpeechInstallJob>();
const log = logger.child({ component: 'speech-install' });

export function speechInstallJobs(): SpeechInstallJob[] {
  return [...jobs.values()].map((j) => ({ ...j, log: [...j.log] }));
}

/**
 * Start installing `engine` in the background; returns the job at once. A
 * second request while one runs returns the running job.
 */
export function startSpeechInstall(engine: InstallableEngine, opts: { size?: string; makePrimary?: boolean } = {}): SpeechInstallJob {
  const running = jobs.get(engine);
  if (running?.stage === 'running') return running;
  const job: SpeechInstallJob = { engine, size: opts.size, stage: 'running', log: [], startedAt: Date.now() };
  jobs.set(engine, job);
  const progress = (line: string) => {
    job.log.push(line.slice(0, 500));
    if (job.log.length > 200) job.log.shift();
  };
  void (async () => {
    try {
      // The name is checked before anything is downloaded under it.
      const { catalogEntry, useSpeechEngine } = await import('./speech-rows');
      catalogEntry(engine, DIRECTION[engine], opts.size);
      if (engine === 'whisper') await (await import('./whisper')).installWhisper(progress);
      else if (engine === 'fasterwhisper') await (await import('./provision')).installFasterWhisper(opts.size || 'small', progress);
      else await (await import('./provision')).installKokoro(progress);
      const used = await useSpeechEngine(engine, DIRECTION[engine], { size: opts.size, makePrimary: opts.makePrimary });
      job.model = used.row.name;
      job.bound = used.bound;
      job.stage = 'done';
    } catch (err) {
      job.stage = 'error';
      job.error = (err as Error).message;
      log.error({ err, engine }, 'Speech engine install failed');
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}
