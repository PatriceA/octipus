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
  | { kind: 'file_exists'; path: string };

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
}

/** Context a scorer may need — currently just the user scope for file checks. */
export interface ScorerContext {
  userId?: string;
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
      default:
        return { error: `scorers[${i}].kind must be one of non_empty|contains|regex|json|file_exists (got "${String(kind)}")` };
    }
  }
  return { scorers };
}

function parseTarget(on: unknown): ScorerTarget | undefined {
  if (on === 'output' || on === 'notes') return on;
  return undefined;
}
