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
 * Scorers are deterministic and run AFTER the child returns `ok`, BEFORE the
 * result is surfaced to the parent. All but one are side-effect free;
 * `command_exit_zero` runs a verification command (a test suite, a build, a
 * linter) because some contracts can only be checked by executing something.
 * Its constraints are documented on the variant.
 */

import { existsSync } from 'node:fs';
import { WorkspaceFS } from '@/security/workspace-fs';
import { commandPolicyViolation, matchElevatedCommand, tokenizeSafe } from '@/tools/shell/policy';
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
    }
  /**
   * Run a command in the child's workspace and pass on exit 0.
   *
   * The only scorer that produces NEW evidence rather than inspecting evidence
   * already collected — this is what lets "done" mean "the suite passes"
   * instead of "the child says the suite passes". It is the roadmap's
   * `pre_verify` (ROADMAP.md, "Completion contracts") in scorer form.
   *
   * Deliberately constrained, because the command comes from a parent LLM
   * whose context can include untrusted tool and web output:
   *
   * - **Only for a child that already holds the shell tool.** A gate must not
   *   be a way to run commands as a role the operator kept away from them, so
   *   a `research` or `writing` child fails this scorer instead of executing
   *   it (`ScorerContext.canRunCommands`).
   * - **The operator's permission decision**, taken through `routeApproval` —
   *   the same decision `tool-executor` and `base-tool` share — because holding
   *   a tool is not the same as being allowed to use it and a third reading of
   *   the stored level would drift from the other two. A stored DENY refuses;
   *   ASK auto-approves exactly as it does for the child's own shell tool.
   * - **The shell tool's own content policy**, shared from `tools/shell/policy`
   *   rather than copied: the same denylist and injection patterns, plus an
   *   outright refusal of anything `ELEVATED_COMMANDS` matches. A verification
   *   command never needs `sudo`, and the elevated path is DENY-by-default for
   *   the tool precisely because nothing should reach it unreviewed.
   * - **SAFE mode**, so `tokenizeSafe` rejects every shell metacharacter (`;`,
   *   `&`, `|`, redirects, `$()`, backticks, newlines, brace expansion). A
   *   verification command is an argv; anything needing a pipeline is not one.
   *   A shell interpreter as the head is refused for the same reason: safe mode
   *   cannot see inside the string `sh -c` is handed, so the guarantee would
   *   stop at the quote.
   * - `cwd` resolved through `WorkspaceFS`, the resolver `file_exists` uses, so
   *   it cannot reach outside the child's workspace.
   * - Hard timeout; a check that hangs is a failed check, not a hung run.
   *
   * What it does NOT get, stated because the opposite is easy to assume: the
   * process sandbox is `security.shellSandbox`, which defaults to `'off'`. When
   * it is off this runs unwrapped and unisolated, exactly like the shell tool.
   * It does not go through the tool's ASK-level `execute` permission either —
   * the capability gate above is what stands in for that, and it is a coarser
   * instrument.
   */
  | { kind: 'command_exit_zero'; command: string; timeoutMs?: number };

export interface ScorerFailure {
  /** Human-readable scorer label, e.g. `regex(/PASS/)` or `file_exists`. */
  scorer: string;
  /** Why it failed — surfaced to the parent so the miss is unambiguous. */
  reason: string;
  /**
   * Whether re-running the child could plausibly fix this. Defaults to true —
   * an ordinary missed check is exactly what the contract retry is for.
   *
   * `false` marks a failure the child has no power over: it holds no shell
   * tool, the operator denied the permission, the command is denylisted, the
   * workspace is missing. Re-dispatching on one of those buys a second
   * identical failure at the price of a full child run, so the retry loop
   * skips it and the parent sees the refusal once.
   */
  retryable?: boolean;
}

export interface ScorerOutcome {
  passed: boolean;
  /** Number of scorers actually evaluated. */
  ran: number;
  /** Empty when `passed` is true. */
  failures: ScorerFailure[];
  /**
   * Set when the gate could not be evaluated at all (today: the run was
   * cancelled). `passed` is true in that case because nothing judged the work —
   * absence of a verdict, not a favourable one.
   */
  notEvaluated?: string;
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
  // `attempt` is the retry index (1 = first retry), so the run being briefed is
  // `attempt + 1` of `maxAttempts + 1`. Telling the final run it is "attempt 1
  // of 2" in the same breath as rejecting its predecessor is a contradiction
  // the model has to resolve.
  return (
    `PREVIOUS ATTEMPT REJECTED. This is attempt ${attempt + 1} of ${maxAttempts + 1}.\n` +
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

/**
 * Shells, which take a command STRING rather than arguments. Refused as the
 * head of a `command_exit_zero` check: safe-mode tokenization cannot see inside
 * the string they are handed, so every guarantee the check rests on stops at
 * the quote.
 */
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'fish', 'csh', 'tcsh']);

/** Flags that hand a shell a command string or a script on stdin. */
const SHELL_STRING_FLAGS = new Set(['-c', '-s', '--command']);

/**
 * The shell a command hands a command string to, or null.
 *
 * Read from the argv the command TOKENIZES to — the form that is actually
 * spawned — so a wrapper or a quote cannot hide it: `env sh -c …`,
 * `timeout 60 sh -c …`, `xargs sh -c …`, `/usr/bin/env bash -c …` and
 * `"sh" -c …` all resolve to the same three tokens.
 *
 * A shell NAMED elsewhere is not the target: `pytest -k sh` mentions one and
 * runs nothing. The pairing with `-c`/`-s` is what makes it an interpreter
 * invocation, and a shell as the head with no such flag (`sh script.sh`) is
 * caught too, since that is still a shell reading a file we cannot inspect.
 */
function namesShellWithCommandString(command: string): string | null {
  const argv = tokenizeSafe(command) ?? command.trim().split(/\s+/);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const name = token.slice(token.lastIndexOf('/') + 1);
    if (!SHELL_INTERPRETERS.has(name)) continue;
    if (i === 0) return name;
    // A shell's OWN flags may sit between it and the one that takes the string:
    // `env sh -x -c "…"`, `timeout 60 bash --norc -c "…"`, `xargs -0 sh -e -c`.
    // Stopping at the immediately-next token missed all three.
    for (let j = i + 1; j < argv.length; j++) {
      if (SHELL_STRING_FLAGS.has(argv[j])) return name;
      if (!/^-{1,2}[a-z]/i.test(argv[j])) break;
    }
  }
  return null;
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
 * Ceiling on the whole gate, across every scorer attached to one spawn. The
 * per-scorer clamp bounds one check; this bounds the set, which is what the
 * caller actually waits on.
 */
export const MAX_SCORER_GATE_MS = 900_000;

/** Default deadline for a `command_exit_zero` check. */
export const DEFAULT_COMMAND_SCORER_TIMEOUT_MS = 120_000;

/** Ceiling on it. A gate is a check, not the run. */
export const MAX_COMMAND_SCORER_TIMEOUT_MS = 600_000;

/** Least time worth starting a command check with. Below it, nothing can pass. */
export const MIN_COMMAND_SCORER_TIMEOUT_MS = 1_000;

/** Upper bound on a verification command's length (parsed from LLM args). */
export const MAX_COMMAND_SCORER_LEN = 500;

/** How much of a failing command's output is quoted back in the failure. */
const MAX_COMMAND_OUTPUT_CHARS = 2_000;

/**
 * Quote a failing command's output into the failure reason, keeping the END.
 *
 * The reason text is what the contract retry puts in front of the next attempt,
 * so which 2k is kept decides whether the retry can act. A test runner's or
 * compiler's first 2k is banner, config and passing cases; the failure, the
 * stack and the summary are all at the tail. `stderr` leads because a build that
 * writes both put the diagnosis there.
 */
export function formatCommandOutput(stdout: string, stderr: string): string {
  const err = (stderr ?? '').trim();
  const out = (stdout ?? '').trim();
  if (!err && !out) return ' with no output';

  // Budgeted separately, not concatenated then truncated — and NEITHER stream
  // may take the whole budget while the other is non-empty. Joining first and
  // keeping the last 2k drops stderr whenever stdout is larger; giving stderr
  // the full budget first drops stdout whenever stderr is larger. A failing
  // `npm test` puts the npm ERR! boilerplate on stderr and the assertion diff
  // on stdout, so either extreme hands the retry the half that says nothing.
  const share = err && out ? Math.floor(MAX_COMMAND_OUTPUT_CHARS / 2) : MAX_COMMAND_OUTPUT_CHARS;
  const errKept = tail(err, err ? share : 0);
  // Whatever stderr did not use goes to stdout, so a short stderr still leaves
  // the full remainder for the diff.
  const outKept = tail(out, out ? MAX_COMMAND_OUTPUT_CHARS - errKept.text.length : 0);

  const parts = [errKept, outKept].filter((p) => p.text.length > 0);
  if (parts.length === 0) return ' with no output';
  const omitted = errKept.omitted + outKept.omitted;
  const body = parts.map((p) => p.text).join('\n');
  return omitted > 0 ? `:\n…(${omitted} earlier chars omitted)\n${body}` : `:\n${body}`;
}

/** The last `budget` characters of `text`, and how many were dropped. */
function tail(text: string, budget: number): { text: string; omitted: number } {
  if (budget <= 0) return { text: '', omitted: text.length };
  if (text.length <= budget) return { text, omitted: 0 };
  return { text: text.slice(-budget), omitted: text.length - budget };
}

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
   * Whether the child holds the shell tool. Gates `command_exit_zero`: a scorer
   * that ran commands for a role without shell access would be a way around the
   * role's toolset rather than a check on its output. Absent (`undefined`) reads
   * as NOT allowed — a gate whose authority cannot be established must not run.
   */
  canRunCommands?: boolean;
  /** The child's role, for the permission decision. */
  role?: string;
  /** Shared wall-clock deadline for the whole gate; set by `runScorers`. */
  deadline?: number;
  /**
   * The run's cancellation signal. Threaded so a `command_exit_zero` check dies
   * with the session instead of outliving it: a cancelled parent otherwise
   * leaves scorer commands running with the awaited spawn unresolved.
   */
  signal?: AbortSignal;
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
  // One deadline for the whole gate, not one per scorer. `parseScorers` allows
  // 20 scorers and each `command_exit_zero` may ask for up to 600s, and they
  // run sequentially AFTER the worker returned — outside the child's
  // `wallClockMs`, which only bounds the spawn. Without this a single spawn
  // could sit in its gates for hours.
  // A caller-supplied deadline wins: the spawn path leaves it unset and gets
  // the default budget, while anything already operating under a tighter one
  // (a test, or a future caller with its own clock) is honoured rather than
  // silently widened.
  const deadline = ctx.deadline ?? Date.now() + MAX_SCORER_GATE_MS;
  let ran = 0;

  for (const scorer of scorers) {
    if (Date.now() >= deadline) {
      failures.push({
        scorer: scorer.kind,
        reason: `the verification gate exceeded its overall ${MAX_SCORER_GATE_MS}ms budget before this check ran`,
        retryable: false,
      });
      break;
    }
    ran++;
    try {
      const failure = await evaluate(scorer, result, { ...ctx, deadline });
      if (failure) failures.push(failure);
    } catch (err) {
      // A gate that could not be EVALUATED is different from one that failed:
      // a cancelled run says nothing about the work, so the whole outcome is
      // reported as not-run rather than as the child missing its contract.
      if (err instanceof ScorerNotEvaluated) {
        coreLogger.info({ scorer: scorer.kind, reason: err.message }, 'Scorer gate not evaluated');
        // Failures already recorded are real verdicts and stand. Only THIS
        // check went unjudged, so the cancellation cannot launder a
        // `file_exists` miss an earlier scorer had already found.
        return {
          passed: failures.length === 0,
          ran: ran - 1,
          failures,
          notEvaluated: err.message,
        };
      }
      // Otherwise: a scorer should never throw, and if it does, treat it as a
      // failed gate so a broken check can't masquerade as a pass.
      coreLogger.error({ err, scorer: scorer.kind }, 'Scorer threw — counting as failure');
      failures.push({ scorer: scorer.kind, reason: `scorer error: ${(err as Error).message}` });
    }
  }

  return { passed: failures.length === 0, ran, failures };
}

/**
 * Raised when a gate could not be evaluated at all — as opposed to evaluated
 * and failed. The only case today is a cancelled run: blaming the child for the
 * operator stopping the session would flip an `ok` result to `contract_failed`,
 * rewrite its receipt and persist a node row saying it missed a contract it
 * never got to be judged against.
 */
export class ScorerNotEvaluated extends Error {}

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
      // Retryable, unlike the command scorer's refusals, and the difference is
      // the point: those are structural (the child holds no shell tool, the
      // operator denied the permission) and identical on a second run, while a
      // side-effect miss is about the work — a child that wrote nothing may
      // well write something when told so, and the always-on outage gate fires
      // on tool failures that are often transient. Bounded by
      // `swarm.contractRetries` either way.
      return misses.length === 0
        ? null
        : {
            scorer: 'side_effect',
            reason: `the child's own execution record contradicts a completed deliverable: ${misses.join('; ')}`,
          };
    }

    case 'command_exit_zero': {
      const label = `command_exit_zero(${truncate(scorer.command, 40)})`;

      // Capability first, before anything is resolved or run. A child without
      // the shell tool must not gain command execution by way of a gate.
      if (!ctx.canRunCommands) {
        return {
          scorer: label,
          reason:
            'this child does not hold the shell tool, so the command was not run — ' +
            'attach this scorer only to a role that runs commands',
          retryable: false,
        };
      }

      // A shell invoked with a command STRING is not a verification command.
      // `tokenizeSafe` treats `sh -c "curl … | sh"` as three tokens and spawns
      // a real shell for the third, so safe mode's "no pipes, no redirects, no
      // `;`" guarantee — which is this scorer's whole argument for letting an
      // LLM-authored string reach a process — does not hold through it. A gate
      // runs `npm test`, `cargo test`, `pytest`; anything that needs a shell to
      // interpret it is not one.
      //
      // Judged on the TOKENIZED argv, not the raw head. A head test sees `env`
      // in `env sh -c "…"` and `timeout` in `timeout 60 sh -c "…"`, and misses
      // `"sh" -c` outright because the quotes are still attached — all three
      // spawn a shell.
      const shellArg = namesShellWithCommandString(scorer.command);
      if (shellArg) {
        return {
          scorer: label,
          reason:
            `refused: "${shellArg}" runs a command string, which defeats the no-shell-features ` +
            'guarantee this check relies on — give the command itself instead',
          retryable: false,
        };
      }

      // The shell tool's content policy, shared rather than restated.
      const violation = commandPolicyViolation(scorer.command);
      if (violation) return { scorer: label, reason: `refused: ${violation}`, retryable: false };
      const elevated = matchElevatedCommand(scorer.command);
      if (elevated) {
        return {
          scorer: label,
          reason:
            `refused: "${elevated}" needs elevated permission, which a verification ` +
            'gate never does',
          retryable: false,
        };
      }

      // Holding the tool is not the same as being allowed to use it: tools are
      // never stripped by permission, the check runs at call time, so an
      // operator's stored DENY on `shell.execute` would be invisible to a
      // toolset test.
      //
      // The decision goes through `routeApproval`, the same one `tool-executor`
      // and `base-tool` share, rather than a third reading of the stored level.
      // That matters concretely: `shell.execute` ships as ASK, and ASK
      // auto-approves for a worker that cannot prompt a human. Demanding ALLOW
      // here would refuse every default install — the child would run `npm test`
      // through its own shell tool and then its verification of that same
      // command would be rejected.
      //
      // `attended: false` is the honest context: a scorer runs after the child
      // is finished, so there is nobody left to ask.
      if (!ctx.userId) {
        // Fail closed, exactly as the catch below does. Without a user there is
        // no permission decision to consult, so the authority to run this was
        // never established — and skipping the check on a falsy id would be a
        // way past it.
        return {
          scorer: label,
          reason: 'refused: no user scope, so the shell permission could not be checked',
          retryable: false,
        };
      }
      {
        try {
          const [{ getPermissionManager }, { routeApproval }] = await Promise.all([
            import('@/security/permissions'),
            import('@/security/approval-policy'),
          ]);
          const permission = await getPermissionManager().check(ctx.userId, 'shell', 'execute', {
            command: scorer.command,
          });
          const { getConfig } = await import('@/config');
          const decision = routeApproval({
            level: permission.level,
            role: ctx.role,
            root: false,
            attended: false,
            toolId: 'shell',
            // The SAME action the permission was read for. `matches()` builds
            // `${toolId}__${action}`, so passing `shell__run` here makes an
            // operator's `unattendedDenyActions: ['shell__execute']` compare
            // against `shell__shell__run` and never fire — while that same
            // entry does block the child's own shell tool.
            action: 'execute',
            unattendedDenyActions: getConfig().multiuser?.unattendedDenyActions,
          });
          if (decision.route !== 'execute') {
            return {
              scorer: label,
              reason: `refused: shell.execute is ${permission.level} for this user${decision.reason ? ` (${decision.reason})` : ''}`,
              retryable: false,
            };
          }
        } catch (err) {
          // Fail closed. An unavailable permission layer means the authority to
          // run this was never established.
          return {
            scorer: label,
            reason: `refused: could not check shell permission (${(err as Error).message})`,
            retryable: false,
          };
        }
      }

      // Workspace: the same sandbox resolver `file_exists` uses. `'.'` is the
      // workspace root, so a command cannot be pointed elsewhere.
      // The workspace root, which is where a swarm child's own tools operate:
      // `pipelineMetadata` forwards only `pipelineId` and `nodeKey`, so a child
      // never receives a `projectPath` and its `file_exists` and `side_effect`
      // scorers resolve here too. Reading the PARENT's `projectPath` instead
      // would point the check at the operator's host checkout in a dev-mode
      // session — a different tree from the one the child changed.
      const fs = WorkspaceFS.forAgent({ userId: ctx.userId });
      const cwd = fs.resolveOptional('.');
      if (!cwd) {
        return {
          scorer: label,
          reason: 'the workspace could not be resolved, so the command was not run',
          retryable: false,
        };
      }
      // A missing workspace directory is an environment fault, not the child's
      // defect. Left unchecked it surfaces as `spawn ENOENT`, gets quoted back
      // as the thing the child must fix, and burns a contract retry on it.
      if (!existsSync(cwd)) {
        return {
          scorer: label,
          reason: `the workspace directory does not exist (${cwd}), so the command was not run`,
          retryable: false,
        };
      }

      // Never outlive the gate's own budget — but a sliver of it is not a
      // deadline, it is a guaranteed timeout blamed on the child. Below the
      // floor the check is reported as unrun, and unfixably so: another child
      // run would meet the same spent budget.
      const gateLeft = ctx.deadline ? ctx.deadline - Date.now() : Number.POSITIVE_INFINITY;
      if (gateLeft < MIN_COMMAND_SCORER_TIMEOUT_MS) {
        return {
          scorer: label,
          reason: `the verification gate had ${Math.max(0, gateLeft)}ms of its budget left, too little to run this check`,
          retryable: false,
        };
      }
      const timeoutMs = Math.min(
        scorer.timeoutMs ?? DEFAULT_COMMAND_SCORER_TIMEOUT_MS,
        MAX_COMMAND_SCORER_TIMEOUT_MS,
        gateLeft,
      );

      // Already cancelled: do not start a process for a run nobody is waiting
      // on, and do not record a verdict on work that was never judged.
      if (ctx.signal?.aborted) {
        throw new ScorerNotEvaluated('the run was cancelled before the check started');
      }

      // Imported here rather than at module scope: `scorers.ts` is imported by
      // the spawn path on every child, and the shell operations module pulls in
      // the process sandbox and its runner probe.
      const { LocalShellOperations } = await import('@/tools/shell/local-operations');
      try {
        const res = await new LocalShellOperations().exec(scorer.command, cwd, {
          timeout: timeoutMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          // Never `unsafe`. Safe mode is what makes `tokenizeSafe` reject shell
          // metacharacters, and it is the whole security argument for letting an
          // LLM-authored string reach a process at all.
        });
        if (res.exitCode === 0) return null;

        // How it ended, not just that it did. `exitCode` is null for a killed
        // process, so a blown deadline would otherwise read "exited null" and
        // the retry brief would name no defect at all.
        // A cancelled run is not a defect in the work — and re-running it is
        // pointless, since the session it belonged to is gone.
        // A cancelled run is not a defect in the work. Returning a failure here
        // would flip an `ok` child to `contract_failed`, rewrite its receipt and
        // persist the node row saying it missed its contract — blaming the child
        // for the operator stopping the session.
        if (res.aborted || ctx.signal?.aborted) {
          throw new ScorerNotEvaluated('the run was cancelled before the check finished');
        }
        // No `aborted` case: an abort is raised as `ScorerNotEvaluated` above,
        // so reaching here means the command produced a real result.
        const how = res.timedOut
          ? `timed out after ${timeoutMs}ms`
          : res.exitCode === null
            ? `was killed${res.signal ? ` by ${res.signal}` : ''}`
            : `exited ${res.exitCode}`;

        return { scorer: label, reason: `${how}${formatCommandOutput(res.stdout, res.stderr)}` };
      } catch (err) {
        if (err instanceof ScorerNotEvaluated) throw err;
        // An abort that surfaced as a throw is still an abort, not a verdict.
        if (ctx.signal?.aborted) {
          throw new ScorerNotEvaluated('the run was cancelled while the check was running');
        }
        const message = (err as Error).message;
        // A gate that could not run never reads as one that passed. But two
        // causes hide here and they are not alike: a malformed command is the
        // PARENT's, unchanged by another attempt, while a missing script or
        // binary is often the very thing the child failed to produce — and
        // `./scripts/verify.sh` not existing yet is exactly what the retry loop
        // is for. Marking that unfixable refuses to correct the defect the
        // check was written to catch.
        const missing = /ENOENT|not found|no such file/i.test(message);
        return { scorer: label, reason: `did not run: ${message}`, retryable: missing ? undefined : false };
      }
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
      case 'command_exit_zero': {
        if (typeof e.command !== 'string' || e.command.trim().length === 0) {
          return { error: `scorers[${i}].command (command_exit_zero) must be a non-empty string` };
        }
        if (e.command.length > MAX_COMMAND_SCORER_LEN) {
          return {
            error: `scorers[${i}].command (command_exit_zero) must be at most ${MAX_COMMAND_SCORER_LEN} characters`,
          };
        }
        let timeoutMs: number | undefined;
        if (e.timeoutMs !== undefined) {
          if (typeof e.timeoutMs !== 'number' || !Number.isInteger(e.timeoutMs) || e.timeoutMs <= 0) {
            return { error: `scorers[${i}].timeoutMs (command_exit_zero) must be a positive integer` };
          }
          if (e.timeoutMs > MAX_COMMAND_SCORER_TIMEOUT_MS) {
            return {
              error: `scorers[${i}].timeoutMs (command_exit_zero) must be at most ${MAX_COMMAND_SCORER_TIMEOUT_MS}`,
            };
          }
          timeoutMs = e.timeoutMs;
        }
        scorers.push({ kind: 'command_exit_zero', command: e.command.trim(), ...(timeoutMs ? { timeoutMs } : {}) });
        break;
      }
      default:
        return {
          error: `scorers[${i}].kind must be one of non_empty|contains|regex|json|file_exists|side_effect|command_exit_zero (got "${String(kind)}")`,
        };
    }
  }
  return { scorers };
}

function parseTarget(on: unknown): ScorerTarget | undefined {
  if (on === 'output' || on === 'notes') return on;
  return undefined;
}
