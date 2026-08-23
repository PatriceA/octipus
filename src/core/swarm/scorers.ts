/**
 * Scorer gates — deterministic verifiers a parent attaches to a `spawn_child`
 * call to check the child actually met its contract, instead of trusting the
 * child's word.
 *
 * Inspired by CodeWhale's Fleet scorers (see
 * `.octipus/codewhale-borrowed-ideas.md`). This operationalizes house-rule #4
 * ("typed deliverable per role"): a role already declares an `expectedOutput`
 * shape; a scorer is a cheap, deterministic check that the deliverable
 * satisfies it. A failed scorer downgrades the child's status to
 * `contract_failed` (fail loud) — the parent decides what to do, rather than
 * synthesizing against an output that silently missed the brief.
 *
 * All scorers are deterministic and side-effect free. They run AFTER the child
 * returns `ok` and BEFORE the result is surfaced to the parent.
 */

import { existsSync } from 'node:fs';
import { WorkspaceFS } from '@/security/workspace-fs';
import { coreLogger } from '@/utils/logger';
import type { SwarmReceipt } from './receipt';

/** Which part of the child result a text scorer inspects. */
export type ScorerTarget = 'output' | 'notes';

/**
 * A single deterministic check. Provided by the parent via `spawn_child`
 * params, so the shapes are intentionally small and validated at the boundary
 * (`parseScorers`).
 */
export type Scorer =
  | { kind: 'non_empty' }
  | { kind: 'contains'; value: string; on?: ScorerTarget }
  | { kind: 'regex'; pattern: string; flags?: string; on?: ScorerTarget }
  | { kind: 'json'; requiredKeys?: string[]; object?: boolean }
  | { kind: 'file_exists'; path: string }
  /**
   * Check the child's DETERMINISTIC RECEIPT rather than anything it said.
   * Every other scorer inspects text the child authored; this one inspects
   * counters the ToolExecutor observed, so "claims success but wrote no files"
   * is caught without parsing prose.
   */
  | {
      kind: 'side_effect';
      minFilesChanged?: number;
      minCommandsRun?: number;
      maxToolErrors?: number;
      /**
       * Fail a child that attempted tools and had EVERY attempt error out.
       * Not the same as `maxToolErrors`: a child with 20 successes and 5
       * errors worked fine, while one with 0 successes and 1 error had no
       * working tools at all and answered from memory. Applied to every
       * spawn (see `deriveToolOutageScorer`), because an answer produced
       * during a total tool outage is unverified no matter how it reads.
       */
      requireWorkingTools?: boolean;
    };

export interface ScorerFailure {
  /** Human-readable scorer label, e.g. `regex(/PASS/)` or `file_exists`. */
  scorer: string;
  /** Why it failed — surfaced to the parent so the miss is unambiguous. */
  reason: string;
}

export interface ScorerOutcome {
  passed: boolean;
  /** Number of scorers actually evaluated. */
  ran: number;
  /** Empty when `passed` is true. */
  failures: ScorerFailure[];
}

/**
 * Render a failed gate as a corrective instruction for a re-dispatch.
 *
 * This is what makes a contract retry a LOOP rather than a re-roll: the second
 * attempt is told precisely which checks failed and why, so it corrects rather
 * than re-sampling the same mistake. Pure and separately testable, because the
 * spawner that calls it cannot be exercised without booting an agent.
 *
 * Returns null when there is nothing actionable to say — an empty failure list
 * means the caller should not be retrying at all, and a retry prompt that names
 * no defect is worse than none: it asks the child to guess what went wrong.
 */
export function renderContractFeedback(
  failures: ScorerFailure[],
  attempt: number,
  maxAttempts: number,
): string | null {
  if (failures.length === 0) return null;
  const lines = failures.map((f) => `- ${f.scorer}: ${f.reason}`).join('\n');
  return (
    `PREVIOUS ATTEMPT REJECTED (attempt ${attempt} of ${maxAttempts + 1}).\n` +
    `Your last answer was produced but FAILED these deterministic checks:\n${lines}\n\n` +
    `Redo the task so every check above passes. The checks are mechanical and ` +
    `will run again on this attempt — they inspect what you actually produced ` +
    `(and, where they read the execution record, what you actually did), not ` +
    `how you describe it. Fix the specific defect named; do not restate the ` +
    `previous answer with different wording.`
  );
}

/**
 * Delegation/meta tools. They move work rather than produce evidence, so they
 * do not count as "a tool that worked" for the outage gate.
 */
const META_TOOLS = new Set(['spawn_child', 'collect_children', 'escalate_to_different_expert']);

/** Cap on the text a `contains` scorer scans — bounds pathological input. */
const MAX_SCAN_CHARS = 100_000;

/**
 * Tighter cap for `regex`: a backtracking match is super-linear, so we keep
 * the scanned text small in addition to the pattern guards in `parseScorers`.
 */
const MAX_REGEX_SCAN_CHARS = 10_000;

/** Upper bound on a scorer regex pattern length (parsed from LLM args). */
export const MAX_REGEX_PATTERN_LEN = 200;

/**
 * Reject regex patterns prone to catastrophic backtracking (ReDoS). The
 * scorer pattern comes from the parent LLM, whose context can include
 * untrusted tool/web output — a malicious pattern like `(a+)+$` could hang
 * the single-threaded runtime. This is a conservative heuristic, not a proof:
 * it flags a quantifier applied to a group that itself ends in a quantifier
 * (nested quantifiers), which covers the classic exponential cases. JS has no
 * built-in linear-time regex engine, so we pair this with `MAX_REGEX_SCAN_CHARS`
 * and `MAX_REGEX_PATTERN_LEN` rather than executing arbitrary patterns freely.
 */
export function looksCatastrophic(pattern: string): boolean {
  // A group `(...)` whose last in-group token is a quantifier, immediately
  // followed by another quantifier: (…+)+ (…*)+ (…+)* (…{n,})? etc.
  return /\([^)]*[+*}]\)\s*[+*{]/.test(pattern);
}

/** The shape of the result a scorer inspects (subset of ChildResult). */
export interface ScorableResult {
  output: unknown;
  notes?: string;
  /** Framework-built side-effect audit; the only non-self-reported evidence. */
  receipt?: SwarmReceipt;
}

/** Context a scorer may need: the user scope for file checks, plus any
 *  filesystem evidence the spawner measured around the child's run. */
export interface ScorerContext {
  userId?: string;
  /**
   * Files that actually differ in the workspace across the child's run, from
   * `workspace-snapshot.ts`. `null` = not measured (no file-aware scorer asked
   * for it, or the workspace could not be walked) — never "nothing changed".
   *
   * Exists because `filesChanged` counts only file-mutating TOOL calls, so a
   * child that writes through `shell__run` reads as having changed nothing.
   */
  filesTouched?: number | null;
}

/**
 * Coerce the targeted field to text, JSON-stringifying non-strings.
 * `null`/`undefined` become the empty string — NOT the literal `"\"\""` —
 * so a `non_empty` gate correctly fails an absent deliverable instead of
 * passing on the JSON encoding of emptiness.
 */
function asText(result: ScorableResult, on: ScorerTarget): string {
  const v = on === 'notes' ? result.notes : result.output;
  let s: string;
  if (typeof v === 'string') s = v;
  else if (v === null || v === undefined) s = '';
  else s = JSON.stringify(v);
  return s.length > MAX_SCAN_CHARS ? s.slice(0, MAX_SCAN_CHARS) : s;
}

/**
 * Run every scorer against a child result. Returns the aggregate outcome —
 * `passed` is true only when ALL scorers pass. A scorer that throws unexpectedly
 * is recorded as a failure (fail loud) rather than skipped.
 */
export async function runScorers(
  scorers: Scorer[],
  result: ScorableResult,
  ctx: ScorerContext,
): Promise<ScorerOutcome> {
  const failures: ScorerFailure[] = [];

  for (const scorer of scorers) {
    try {
      const failure = await evaluate(scorer, result, ctx);
      if (failure) failures.push(failure);
    } catch (err) {
      // A scorer should never throw; if it does, treat it as a failed gate so
      // a broken check can't masquerade as a pass.
      coreLogger.error({ err, scorer: scorer.kind }, 'Scorer threw — counting as failure');
      failures.push({ scorer: scorer.kind, reason: `scorer error: ${(err as Error).message}` });
    }
  }

  return { passed: failures.length === 0, ran: scorers.length, failures };
}

/** Evaluate one scorer. Returns a failure, or null when it passes. */
async function evaluate(
  scorer: Scorer,
  result: ScorableResult,
  ctx: ScorerContext,
): Promise<ScorerFailure | null> {
  switch (scorer.kind) {
    case 'non_empty': {
      const text = asText(result, 'output').trim();
      return text.length > 0 ? null : { scorer: 'non_empty', reason: 'output is empty' };
    }

    case 'contains': {
      const on = scorer.on ?? 'output';
      const text = asText(result, on);
      return text.includes(scorer.value)
        ? null
        : { scorer: `contains(${on})`, reason: `${on} does not contain "${truncate(scorer.value)}"` };
    }

    case 'regex': {
      const on = scorer.on ?? 'output';
      let re: RegExp;
      try {
        re = new RegExp(scorer.pattern, scorer.flags);
      } catch (err) {
        return { scorer: `regex(${truncate(scorer.pattern)})`, reason: `invalid regex: ${(err as Error).message}` };
      }
      // Tighter scan bound than other scorers — backtracking is super-linear.
      const text = asText(result, on).slice(0, MAX_REGEX_SCAN_CHARS);
      return re.test(text)
        ? null
        : { scorer: `regex(${truncate(scorer.pattern)})`, reason: `${on} does not match /${truncate(scorer.pattern)}/${scorer.flags ?? ''}` };
    }

    case 'json': {
      const raw = result.output;
      let obj: unknown;
      if (typeof raw === 'string') {
        try {
          // Tolerate a ```json / ``` code fence — weak models routinely wrap
          // JSON in one despite instructions, and the JSON inside is still
          // conforming (matches parseQAResult's fence tolerance).
          obj = JSON.parse(stripJsonFence(raw));
        } catch {
          return { scorer: 'json', reason: 'output is not valid JSON' };
        }
      } else {
        obj = raw;
      }
      const isObject = obj !== null && typeof obj === 'object' && !Array.isArray(obj);
      // `object: true` enforces object-ness even with no requiredKeys — a
      // schema of `{ type: 'object' }` must reject bare `42`/`null`/an array.
      if (scorer.object && !isObject) {
        return { scorer: 'json', reason: 'output is not a JSON object' };
      }
      if (scorer.requiredKeys && scorer.requiredKeys.length > 0) {
        if (!isObject) {
          return { scorer: 'json', reason: 'output is not a JSON object, so required keys cannot be present' };
        }
        const present = new Set(Object.keys(obj as Record<string, unknown>));
        const missing = scorer.requiredKeys.filter((k) => !present.has(k));
        if (missing.length > 0) {
          return { scorer: 'json', reason: `missing required keys: ${missing.join(', ')}` };
        }
      }
      return null;
    }

    case 'file_exists': {
      // Resolve through the child's workspace sandbox — the same resolver the
      // filesystem tool uses — so the check respects per-user roots and path
      // relocation instead of guessing at an absolute path.
      const fs = WorkspaceFS.forAgent({ userId: ctx.userId });
      const resolved = fs.resolveOptional(scorer.path);
      if (!resolved) {
        return { scorer: 'file_exists', reason: `path "${truncate(scorer.path)}" is outside the workspace` };
      }
      return existsSync(resolved)
        ? null
        : { scorer: 'file_exists', reason: `file "${truncate(scorer.path)}" does not exist` };
    }

    case 'side_effect': {
      const receipt = result.receipt;
      // No receipt, or counters the framework genuinely could not capture (a
      // CLI worker exposes none): we cannot distinguish "did nothing" from
      // "could not observe". PASS rather than invent a contract failure —
      // CLI workers are a primary coding path, and failing them all would be
      // a regression, not a gate. The receipt already surfaces `unavailable`
      // to the parent, so the uncertainty is visible either way.
      if (!receipt || receipt.unavailable.length > 0) {
        coreLogger.debug(
          { nodeId: receipt?.nodeId, unavailable: receipt?.unavailable },
          'side_effect scorer: no observable counters — gate not evaluated',
        );
        return null;
      }

      const s = receipt.sideEffects;
      const misses: string[] = [];
      if (scorer.minFilesChanged !== undefined && s.filesChanged < scorer.minFilesChanged) {
        // Second opinion before failing: `filesChanged` only counts
        // file-mutating TOOL calls, so a child that wrote through `shell__run`
        // reads as zero here while the files are plainly on disk. The workspace
        // diff sees those. `null` means nothing measured, which cannot rescue
        // the miss — only a positive count does.
        const onDisk = ctx.filesTouched ?? null;
        if (onDisk === null || onDisk < scorer.minFilesChanged) {
          misses.push(
            `filesChanged=${s.filesChanged} (expected >= ${scorer.minFilesChanged})` +
              (onDisk === null ? '' : `, and only ${onDisk} file(s) differ in the workspace`),
          );
        }
      }
      if (scorer.minCommandsRun !== undefined && s.commandsRun < scorer.minCommandsRun) {
        misses.push(`commandsRun=${s.commandsRun} (expected >= ${scorer.minCommandsRun})`);
      }
      if (scorer.maxToolErrors !== undefined && s.toolErrors > scorer.maxToolErrors) {
        misses.push(`toolErrors=${s.toolErrors} (expected <= ${scorer.maxToolErrors})`);
      }
      // Total tool outage: it reached for tools and not one of them worked.
      // `toolCalls` counts only SUCCESSFUL calls (see SideEffectCounters), so
      // zero successes beside a non-zero error count means every attempt
      // failed and whatever the child returned came from its own memory.
      //
      // Delegation does not count as a working tool. In the run that motivated
      // this gate the child's 5 web searches all failed while `spawn_child`
      // succeeded, which left `toolCalls = 1` and hid a total outage behind a
      // meta-call. Handing the problem to someone else is not evidence.
      if (scorer.requireWorkingTools) {
        const substantive = Object.entries(s.byName)
          .filter(([name]) => !META_TOOLS.has(name))
          .reduce((a, [, n]) => a + n, 0);
        if (s.toolErrors > 0 && substantive === 0) {
          misses.push(
            `every tool call failed (${s.toolErrors} error(s), 0 succeeded) — ` +
              `the deliverable cannot be based on anything the tools returned`,
          );
        }
      }
      return misses.length === 0
        ? null
        : {
            scorer: 'side_effect',
            reason: `the child's own execution record contradicts a completed deliverable: ${misses.join('; ')}`,
          };
    }
  }
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Unwrap a leading ```json / ``` code fence, returning the JSON inside. */
function stripJsonFence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  return (m ? m[1] : s).trim();
}

/**
 * Derive a deterministic output gate from a brief's `expectedOutput.schema`
 * (Phase B1). When a spawn declares a JSON Schema, enforce it by reusing the
 * shallow `json` scorer: the child's output must be a valid JSON object carrying
 * the schema's required top-level keys (its `required` list, else all declared
 * `properties`). This is a SHAPE gate, not full JSON-Schema validation — no
 * nested/type checks — but it fails loud (→ `contract_failed`) when a child
 * returns prose or the wrong shape, with no schema library and no change to the
 * hot agent-worker loop. Returns null when there's no usable schema, so callers
 * only add a gate when one was actually declared.
 *
 * Deeper (typed/nested) validation is a deferred hardening — see the follow-ups
 * plan (B1). Until then this catches the failure the plan cares about most: a
 * model that ignored the schema and emitted free prose.
 *
 * Enforces object-ness plus the schema's `required` keys ONLY. JSON Schema is
 * optional-by-default, so a key in `properties` but not `required` is NOT
 * demanded — promoting `properties` to required would reject valid partial
 * output (a child that legitimately omits an optional field).
 */
export function deriveSchemaScorer(schema: unknown): Scorer | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;
  const requiredKeys = Array.isArray(s.required)
    ? s.required.filter((k): k is string => typeof k === 'string')
    : [];
  return { kind: 'json', requiredKeys, object: true };
}

/**
 * Auto-gate for a declared code deliverable.
 *
 * When a parent declares `expectedOutput.shape === 'code-diff'` it has stated
 * that the deliverable IS a change to the tree. A child that returns `ok` while
 * its receipt shows zero files changed has definitionally missed that contract,
 * no matter how confident its prose is — this is the "implemented successfully"
 * / nothing-on-disk case, caught deterministically.
 *
 * Deliberately narrow. It keys off an explicit declaration rather than guessing
 * from the brief's wording, so it cannot produce a false `contract_failed` for a
 * child that was never supposed to write anything. Broadening it to infer intent
 * from the task text needs the drift work (see docs/plans/quality-enforcement.md
 * T2.2); a wrong guess here is worse than no gate, because it fails work that
 * actually succeeded.
 */
export function deriveCodeDiffScorer(shape: string | undefined): Scorer | null {
  return shape === 'code-diff' ? { kind: 'side_effect', minFilesChanged: 1 } : null;
}

/**
 * The one gate that applies to EVERY spawn: a child whose every tool call
 * failed did not gather anything, so its answer is unverified regardless of
 * how confident the prose sounds.
 *
 * This exists because of a measured failure, not a hypothetical (see
 * docs/plans/quality-loop-status.md): a research child made 5 web searches,
 * all 5 failed because every search engine was blocked, it died on a provider
 * error, the spawner retried, and the retry answered from model memory. The
 * run was reported `ok` and the user got a polished, entirely unsourced
 * itinerary with no indication that fact-checking had failed completely.
 *
 * Unconditional — unlike `deriveCodeDiffScorer`, which needs an explicit
 * declaration — because it cannot produce a false failure: a child that never
 * touched a tool has `toolErrors === 0` and is untouched, and a child with any
 * successful call is untouched. It only fires when tools were tried and none
 * worked, which is never a healthy run.
 */
export function deriveToolOutageScorer(): Scorer {
  return { kind: 'side_effect', requireWorkingTools: true };
}

/**
 * Validate + normalize an untrusted `scorers` arg from a `spawn_child` call.
 * Returns the parsed scorers, or an error string describing the first invalid
 * entry (fail loud — a malformed scorer spec is reported, not silently dropped).
 * A missing/empty arg yields an empty list (scorers are opt-in).
 */
export function parseScorers(raw: unknown): { scorers: Scorer[] } | { error: string } {
  if (raw === undefined || raw === null) return { scorers: [] };
  if (!Array.isArray(raw)) return { error: 'scorers must be an array' };
  if (raw.length > 20) return { error: 'too many scorers (max 20)' };

  const scorers: Scorer[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') return { error: `scorers[${i}] must be an object` };
    const e = entry as Record<string, unknown>;
    const kind = e.kind;
    switch (kind) {
      case 'non_empty':
        scorers.push({ kind: 'non_empty' });
        break;
      case 'contains': {
        if (typeof e.value !== 'string' || e.value.length === 0) {
          return { error: `scorers[${i}].value (contains) must be a non-empty string` };
        }
        scorers.push({ kind: 'contains', value: e.value, on: parseTarget(e.on) });
        break;
      }
      case 'regex': {
        if (typeof e.pattern !== 'string' || e.pattern.length === 0) {
          return { error: `scorers[${i}].pattern (regex) must be a non-empty string` };
        }
        if (e.pattern.length > MAX_REGEX_PATTERN_LEN) {
          return { error: `scorers[${i}].pattern (regex) exceeds ${MAX_REGEX_PATTERN_LEN} chars` };
        }
        if (looksCatastrophic(e.pattern)) {
          return {
            error: `scorers[${i}].pattern (regex) has nested quantifiers prone to catastrophic backtracking — simplify it`,
          };
        }
        if (e.flags !== undefined && typeof e.flags !== 'string') {
          return { error: `scorers[${i}].flags (regex) must be a string` };
        }
        scorers.push({ kind: 'regex', pattern: e.pattern, flags: e.flags as string | undefined, on: parseTarget(e.on) });
        break;
      }
      case 'json': {
        let requiredKeys: string[] | undefined;
        if (e.requiredKeys !== undefined) {
          if (!Array.isArray(e.requiredKeys) || e.requiredKeys.some((k) => typeof k !== 'string')) {
            return { error: `scorers[${i}].requiredKeys (json) must be an array of strings` };
          }
          requiredKeys = e.requiredKeys as string[];
        }
        scorers.push({ kind: 'json', requiredKeys });
        break;
      }
      case 'file_exists': {
        if (typeof e.path !== 'string' || e.path.length === 0) {
          return { error: `scorers[${i}].path (file_exists) must be a non-empty string` };
        }
        scorers.push({ kind: 'file_exists', path: e.path });
        break;
      }
      case 'side_effect': {
        const bounds: { minFilesChanged?: number; minCommandsRun?: number; maxToolErrors?: number } = {};
        for (const key of ['minFilesChanged', 'minCommandsRun', 'maxToolErrors'] as const) {
          const v = e[key];
          if (v === undefined) continue;
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
            return { error: `scorers[${i}].${key} (side_effect) must be a non-negative integer` };
          }
          bounds[key] = v;
        }
        const requireWorkingTools = e.requireWorkingTools;
        if (requireWorkingTools !== undefined && typeof requireWorkingTools !== 'boolean') {
          return { error: `scorers[${i}].requireWorkingTools (side_effect) must be a boolean` };
        }
        if (Object.keys(bounds).length === 0 && !requireWorkingTools) {
          return { error: `scorers[${i}] (side_effect) needs at least one of minFilesChanged, minCommandsRun, maxToolErrors, requireWorkingTools` };
        }
        scorers.push({
          kind: 'side_effect',
          ...bounds,
          ...(requireWorkingTools ? { requireWorkingTools } : {}),
        });
        break;
      }
      default:
        return {
          error: `scorers[${i}].kind must be one of non_empty|contains|regex|json|file_exists|side_effect (got "${String(kind)}")`,
        };
    }
  }
  return { scorers };
}

function parseTarget(on: unknown): ScorerTarget | undefined {
  if (on === 'output' || on === 'notes') return on;
  return undefined;
}
