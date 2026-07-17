import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { TrajectoryRecord } from '@/core/trajectories/types';

/**
 * Turn a recorded trajectory into distiller input material. Pure and IO-free.
 * PII is already stripped at record time (the recorder + filter_pii), so this
 * just assembles the salient parts: the task, the outcome, and the shape of the
 * work (tools/roles used) — enough for the distiller to extract the procedure.
 */
export function trajectoryToDistillMaterial(record: TrajectoryRecord): string {
  const toolSteps = (record.steps ?? [])
    .filter((s) => s.kind === 'tool_call' && s.tool)
    .map((s) => s.tool);
  const roleSteps = (record.steps ?? [])
    .filter((s) => s.kind === 'spawn' && s.role)
    .map((s) => s.role);

  const lines = [
    `Task: ${record.userMessage}`.trim(),
    record.classification?.topic ? `Topic: ${record.classification.topic}` : '',
    toolSteps.length ? `Tools used: ${[...new Set(toolSteps)].join(', ')}` : '',
    roleSteps.length ? `Roles involved: ${[...new Set(roleSteps)].join(', ')}` : '',
    '',
    `Result:\n${record.finalResponse}`.trim(),
  ];
  return lines.filter((l) => l !== '').join('\n').trim();
}

/**
 * Read the full trajectory record at `path:line`. The pointer row stores the
 * uncompressed path; the daily compressor may have gzipped it since, so fall
 * back to `${path}.gz`. Returns null when the file/line is gone or unparseable
 * (the caller surfaces a clear error — never a fabricated record).
 */
export function readTrajectoryRecordLine(path: string, line: number): TrajectoryRecord | null {
  let body: string | null = null;
  if (existsSync(path)) {
    body = readFileSync(path, 'utf8');
  } else if (existsSync(`${path}.gz`)) {
    body = gunzipSync(readFileSync(`${path}.gz`)).toString('utf8');
  }
  if (body === null) return null;

  const lines = body.split('\n');
  const raw = lines[line]?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TrajectoryRecord;
  } catch {
    return null;
  }
}
