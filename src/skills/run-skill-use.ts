import { getRunId } from '@/core/run-context';

/**
 * Which orchestrated turns (`run_<uuid>`) had a skill's body put in front of
 * an agent: a full-content injection (selected, required or topic skills) or
 * `get_skill`. Read once, when the turn ends, by the distil offer
 * (src/core/learning/distill-nudge-service.ts): a run that already used a
 * skill is not offered as a new one. Mounted filesystem skills count too,
 * unlike the usage counter.
 *
 * In memory: a run is one process, and an entry the turn never takes (a turn
 * that failed) is dropped once more than `MAX_RUNS` runs are held.
 */
const MAX_RUNS = 1000;
const used = new Set<string>();

/** The ambient run loaded at least one skill. Outside a run, nothing is noted. */
export function noteRunSkillUse(skillCount: number): void {
  if (skillCount === 0) return;
  const runId = getRunId();
  if (!runId || used.has(runId)) return;
  used.add(runId);
  if (used.size > MAX_RUNS) used.delete(used.values().next().value as string);
}

/** Whether `runId` used a skill; forgets the run. */
export function takeRunSkillUse(runId: string): boolean {
  return used.delete(runId);
}
