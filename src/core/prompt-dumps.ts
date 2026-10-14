import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentLogger } from '@/utils/logger';
import { sweepStaleFiles } from './cli-adapters';

/** How long a prompt dump is kept. */
const PROMPT_DUMP_MAX_AGE_MS = 7 * 24 * 3600_000;

/**
 * Write one prompt dump (`~/.octipus/prompts/<fileName>`, owner-only)
 * without holding up the run that made it: the write is async, and the
 * 7-day sweep of old dumps runs at most hourly (`sweepStaleFiles`). A
 * failed write is logged, never thrown — a dump is a debugging aid.
 * The caller builds `body` first, so it is the prompt as it was.
 */
export function writePromptDump(fileName: string, body: string, log: Record<string, unknown>): void {
  const dir = join(homedir(), '.octipus', 'prompts');
  const path = join(dir, fileName);
  void (async () => {
    await mkdir(dir, { recursive: true });
    sweepStaleFiles(dir, '', PROMPT_DUMP_MAX_AGE_MS);
    await writeFile(path, body, { encoding: 'utf-8', mode: 0o600 });
    agentLogger.info({ ...log, path }, 'Dumped agent prompt');
  })().catch((err: unknown) => agentLogger.debug({ err, ...log }, 'Failed to dump agent prompt'));
}
