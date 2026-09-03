/**
 * Trajectory recorder — observes one root agent `handleMessage` run and
 * writes a single JSONL line to disk + a pointer row to `trajectory_runs`.
 *
 * Design notes:
 * - The recorder is a passive observer: it is fed events by the root agent
 *   and does NOT rewrite orchestration. This file owns the write path only.
 * - Set env `TRAJECTORY_LOGGING=false` to make every recorder a no-op.
 * - PII (emails, phone numbers) is stripped from `userMessage` and
 *   `finalResponse` before writing. The full `filter_pii` PII filter covers
 *   additional categories (SSN, credit cards, API keys, IPs).
 * - JSONL files live at `${workspace.rootPath}/trajectories/YYYY-MM-DD.jsonl`.
 *   They are append-only and rolled over per-day. The companion compress
 *   script (`scripts/trajectories/compress.ts`) gzips yesterday's file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { gzipSync } from 'zlib';
import { getConfig } from '@/config';
import { filterPII } from '@/core/agent/pii-filter';
import type { MessageClassification } from '@/core/agent/types';
import { coreLogger } from '@/utils/logger';
import type {
  TrajectoryClassification,
  TrajectoryOutcome,
  TrajectoryRecord,
  TrajectoryStep,
} from './types';

/**
 * Returns true when trajectory logging is opted-out via the env var.
 */
export function isTrajectoryLoggingDisabled(): boolean {
  const v = process.env.TRAJECTORY_LOGGING;
  if (v === undefined || v === null) return false;
  const norm = v.trim().toLowerCase();
  return norm === 'false' || norm === '0' || norm === 'no' || norm === 'off';
}

/**
 * Compute the JSONL file path for a given date.
 * Pattern: `${workspaceRoot}/trajectories/YYYY-MM-DD.jsonl`.
 *
 * Exported for the compress script and tests — real code should go through
 * the recorder which handles this internally.
 */
export function trajectoryFilePathForDate(date: Date, rootOverride?: string): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const root = rootOverride ?? resolveWorkspaceRoot();
  return resolve(root, 'trajectories', `${y}-${m}-${d}.jsonl`);
}

export type CompressResult = 'compressed' | 'already-compressed' | 'no-file';

/**
 * Gzip the trajectory JSONL for `date` to `<path>.gz` and remove the source.
 * Idempotent: if the `.gz` already exists the (now-redundant) source is removed;
 * if there is no source at all it's a no-op. Called by the daily cron and the
 * `scripts/trajectories/compress.ts` CLI.
 */
export function compressTrajectoryForDate(date: Date, rootOverride?: string): CompressResult {
  const path = trajectoryFilePathForDate(date, rootOverride);
  const gz = `${path}.gz`;

  if (!existsSync(path)) return 'no-file';
  if (existsSync(gz)) {
    unlinkSync(path); // gz already made; drop the leftover source
    return 'already-compressed';
  }
  const data = readFileSync(path);
  writeFileSync(gz, gzipSync(data));
  unlinkSync(path);
  return 'compressed';
}

function resolveWorkspaceRoot(): string {
  // Prefer the live config. Fall back to env / cwd when config isn't loaded
  // (e.g. in unit tests that don't bootstrap the full runtime).
  try {
    return resolve(getConfig().workspace.rootPath);
  } catch {
    return resolve(process.env.WORKSPACE_PATH || './workspace');
  }
}

/**
 * Apply the lightweight PII sweep required for every trajectory write.
 * Returns the redacted text plus a flag indicating whether anything changed.
 */
function redactForWrite(text: string): { text: string; redacted: boolean } {
  if (!text) return { text: '', redacted: false };
  const r = filterPII(text);
  return { text: r.filtered, redacted: r.hasRedactions };
}

export interface TrajectoryRecorderOptions {
  rootSessionId: string;
  userId: string;
  userMessage: string;
  channel?: string;
  classification?: MessageClassification;
  expertId?: string;
  /** Override the workspace root — used by tests to target a tmp dir. */
  workspaceRootOverride?: string;
  /** When true, suppress DB writes (useful from tests that don't spin up Postgres). */
  skipDbPointer?: boolean;
}

/**
 * Build a TrajectoryClassification from the root agent's
 * MessageClassification plus an optional expertId.
 */
function toClassification(
  c?: MessageClassification,
  expertId?: string,
): TrajectoryClassification {
  if (!c) {
    return { confidence: 0, expert: expertId };
  }
  return {
    topic: c.topic,
    expert: expertId,
    confidence: c.confidence ?? 0,
    type: c.type,
    complexity: c.complexity,
  };
}

/**
 * Observer for a single root agent run. Create one at the top of
 * `handleMessage`, feed it events as they arrive (llm calls, tool calls,
 * spawns), call `finalize(...)` exactly once.
 *
 * All methods are no-ops when `TRAJECTORY_LOGGING=false`.
 */
export class TrajectoryRecorder {
  private readonly disabled: boolean;
  private readonly startedAt: Date;
  private readonly steps: TrajectoryStep[] = [];
  private readonly modelsUsed = new Set<string>();
  private readonly expertsUsed = new Set<string>();
  private totalTokens = 0;
  private totalCostUsd: number | undefined;
  private classification: TrajectoryClassification;
  private readonly opts: TrajectoryRecorderOptions;

  constructor(opts: TrajectoryRecorderOptions) {
    this.opts = opts;
    this.disabled = isTrajectoryLoggingDisabled();
    this.startedAt = new Date();
    this.classification = toClassification(opts.classification, opts.expertId);
    if (opts.expertId) this.expertsUsed.add(opts.expertId);
  }

  /** True when recorder is inert (opt-out). */
  isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Late-update the classification after the root agent runs the
   * classifier. Safe to call multiple times — last write wins.
   */
  setClassification(c: MessageClassification, expertId?: string): void {
    if (this.disabled) return;
    this.classification = toClassification(c, expertId ?? this.opts.expertId);
  }

  /** Track a model name that was consulted during this run. */
  noteModel(model?: string | null): void {
    if (this.disabled || !model) return;
    this.modelsUsed.add(model);
  }

  /** Track an expert invoked during this run. */
  noteExpert(expertId?: string | null): void {
    if (this.disabled || !expertId) return;
    this.expertsUsed.add(expertId);
  }

  /** Accumulate token counts as they come in from workers. */
  addTokens(n: number | undefined): void {
    if (this.disabled || !n || !Number.isFinite(n)) return;
    this.totalTokens += n;
  }

  /** Accumulate cost in USD (optional — only some providers report it). */
  addCostUsd(n: number | undefined): void {
    if (this.disabled || !n || !Number.isFinite(n)) return;
    this.totalCostUsd = (this.totalCostUsd ?? 0) + n;
  }

  /**
   * Record a single step. Only small, serializable fields should go in
   * `data` — we want a JSONL line to stay under ~10KB typical.
   */
  recordStep(step: Omit<TrajectoryStep, 'timestamp'> & { timestamp?: string }): void {
    if (this.disabled) return;
    this.steps.push({
      timestamp: step.timestamp ?? new Date().toISOString(),
      kind: step.kind,
      model: step.model,
      tool: step.tool,
      role: step.role,
      tokensIn: step.tokensIn,
      tokensOut: step.tokensOut,
      durationMs: step.durationMs,
      outcome: step.outcome,
      error: step.error,
      data: step.data,
    });
    if (step.model) this.modelsUsed.add(step.model);
    if (step.tokensIn) this.totalTokens += step.tokensIn;
    if (step.tokensOut) this.totalTokens += step.tokensOut;
  }

  /** Convenience wrapper for recording LLM calls. */
  recordLlmCall(info: {
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
    outcome?: string;
    error?: string;
  }): void {
    this.recordStep({ kind: 'llm_call', ...info });
  }

  recordToolCall(info: {
    tool: string;
    durationMs?: number;
    outcome?: string;
    error?: string;
    data?: Record<string, unknown>;
  }): void {
    this.recordStep({ kind: 'tool_call', ...info });
  }

  recordSpawn(info: {
    role?: string;
    model?: string;
    durationMs?: number;
    outcome?: string;
    error?: string;
    tokensIn?: number;
    tokensOut?: number;
  }): void {
    this.recordStep({ kind: 'spawn', ...info });
  }

  recordResponse(info: { durationMs?: number; outcome?: string; error?: string }): void {
    this.recordStep({ kind: 'response', ...info });
  }

  /**
   * Finalize the trajectory — build the record, redact PII, append a JSONL
   * line, and insert a DB pointer row. Idempotent only at the call site;
   * calling twice will produce two records.
   */
  async finalize(args: {
    finalResponse: string;
    outcome: TrajectoryOutcome;
    failureReason?: string;
  }): Promise<TrajectoryRecord | null> {
    if (this.disabled) return null;

    const endedAt = new Date();
    const userRed = redactForWrite(this.opts.userMessage);
    const respRed = redactForWrite(args.finalResponse ?? '');
    const piiRedacted = userRed.redacted || respRed.redacted;

    const record: TrajectoryRecord = {
      schemaVersion: 1,
      rootSessionId: this.opts.rootSessionId,
      userId: this.opts.userId,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      userMessage: userRed.text,
      classification: this.classification,
      steps: this.steps,
      finalResponse: respRed.text,
      outcome: args.outcome,
      failureReason: args.failureReason,
      totalTokens: this.totalTokens,
      totalCostUsd: this.totalCostUsd,
      modelsUsed: Array.from(this.modelsUsed),
      expertsUsed: Array.from(this.expertsUsed),
      piiRedacted,
      channel: this.opts.channel,
    };

    // Write JSONL + pointer row. Any failure here is swallowed and logged —
    // trajectory logging must NEVER break user-facing handleMessage.
    let jsonlPath: string;
    let jsonlLine: number;
    try {
      const written = writeJsonlLine(record, this.opts.workspaceRootOverride);
      jsonlPath = written.path;
      jsonlLine = written.line;
    } catch (err) {
      coreLogger.error({ err }, 'Trajectory JSONL write failed');
      return record;
    }

    if (!this.opts.skipDbPointer) {
      try {
        // Lazy import to avoid pulling the db into test paths that stub it.
        const { trajectoryRepository } = await import('@/db/repositories/trajectory-repository');
        await trajectoryRepository.create({
          userId: record.userId,
          rootSessionId: record.rootSessionId,
          outcome: record.outcome,
          startedAt: new Date(record.startedAt),
          endedAt: new Date(record.endedAt),
          totalTokens: record.totalTokens,
          jsonlPath,
          jsonlLine,
        });
      } catch (err) {
        coreLogger.error({ err }, 'Trajectory DB pointer insert failed');
      }
    }

    return record;
  }
}

/**
 * Append one record as a JSONL line and return the path + 1-based line
 * number the record was written to. Exported for unit tests.
 */
export function writeJsonlLine(
  record: TrajectoryRecord,
  rootOverride?: string,
): { path: string; line: number } {
  const path = trajectoryFilePathForDate(new Date(), rootOverride);
  // Use path.dirname so this works on Windows (\\) as well as POSIX (/).
  // The previous `substring(0, lastIndexOf('/'))` returned '' on Windows
  // paths, which made mkdirSync fail with ENOENT.
  mkdirSync(dirname(path), { recursive: true });

  // Count existing lines so we can report back the new line number. We use
  // stat-based size + a single newline-count pass only when the file exists.
  let preCount = 0;
  try {
    const st = statSync(path);
    if (st.size > 0) {
      // Line-count via Bun.readFileSync is fine — these files are small.
      const { readFileSync } = require('fs') as typeof import('fs');
      const buf = readFileSync(path, 'utf8');
      preCount = buf.split('\n').filter(l => l.length > 0).length;
    }
  } catch {
    preCount = 0;
  }

  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
  return { path, line: preCount + 1 };
}
