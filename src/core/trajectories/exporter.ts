import { filterPII } from '@/core/agent/pii-filter';
import type { TrajectoryOutcome, TrajectoryRecord } from './types';

/**
 * Turns recorded trajectories into labeled training pairs — the consumer end
 * of the trajectory system (recorder → JSONL → THIS). Emits a standard
 * chat-format example per run, suitable for offline eval / fine-tune pipelines.
 *
 * Pure and IO-free so it is unit-testable; the CLI in
 * `scripts/trajectories/export.ts` handles file discovery and writing.
 */

export interface ExportFilters {
  /** Keep only runs with this outcome (e.g. 'success' for a clean fine-tune set). */
  outcome?: TrajectoryOutcome;
  /** Inclusive lower bound on the run's start time. */
  from?: Date;
  /** Inclusive upper bound on the run's start time. */
  to?: Date;
}

export interface TrainingMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TrainingExample {
  messages: TrainingMessage[];
  meta: {
    rootSessionId: string;
    outcome: TrajectoryOutcome;
    topic?: string;
    complexity?: string;
    startedAt: string;
    endedAt: string;
    steps: number;
    totalTokens: number;
    modelsUsed: string[];
    channel?: string;
  };
}

/** Whether a record passes the export filters. */
export function shouldExport(record: TrajectoryRecord, filters: ExportFilters): boolean {
  if (filters.outcome && record.outcome !== filters.outcome) return false;
  const started = new Date(record.startedAt).getTime();
  if (filters.from && started < filters.from.getTime()) return false;
  if (filters.to && started > filters.to.getTime()) return false;
  return true;
}

/**
 * Convert one trajectory into a chat-format training example. PII is re-filtered
 * at export time unconditionally — belt and braces, since the recorder only
 * strips email/phone inline while `filterPII` covers SSN/cards/keys/IPs too.
 */
export function toTrainingExample(record: TrajectoryRecord): TrainingExample {
  return {
    messages: [
      { role: 'user', content: filterPII(record.userMessage).filtered },
      { role: 'assistant', content: filterPII(record.finalResponse).filtered },
    ],
    meta: {
      rootSessionId: record.rootSessionId,
      outcome: record.outcome,
      topic: record.classification?.topic,
      complexity: record.classification?.complexity,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      steps: record.steps?.length ?? 0,
      totalTokens: record.totalTokens,
      modelsUsed: record.modelsUsed ?? [],
      channel: record.channel,
    },
  };
}

/**
 * Parse a JSONL body into training examples, applying filters. Returns the kept
 * examples plus counts so callers can report exactly what was dropped (never a
 * silent truncation). Malformed lines are counted, not thrown.
 */
export function exportFromJsonl(
  body: string,
  filters: ExportFilters,
): { examples: TrainingExample[]; scanned: number; malformed: number; filtered: number } {
  const examples: TrainingExample[] = [];
  let scanned = 0;
  let malformed = 0;
  let filtered = 0;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    scanned++;
    let record: TrajectoryRecord;
    try {
      record = JSON.parse(trimmed) as TrajectoryRecord;
    } catch {
      malformed++;
      continue;
    }
    if (!shouldExport(record, filters)) {
      filtered++;
      continue;
    }
    examples.push(toTrainingExample(record));
  }
  return { examples, scanned, malformed, filtered };
}
