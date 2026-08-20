/**
 * Arm capability contracts (roadmap wave 3).
 *
 * A role is an arm, and an arm has a contract: the tools it can reach and,
 * therefore, the kinds of work it can actually perform. Dispatch already
 * checked depth, starvation and budget before spawning — never whether the arm
 * it was about to pay for could do the job at all. A `qa` stage declared
 * `runsCommands` whose role has no shell does not fail; it returns a confident
 * paragraph about tests it never ran, and only the post-run evidence gate
 * notices, after the tokens are spent.
 *
 * Two checks, deliberately at two altitudes:
 *
 * - `stageContractErrors` is STATIC — the role's declared toolset versus what
 *   the template says the stage is for. It runs where `validateGraph` runs, so
 *   an impossible template is refused before the first node executes.
 * - `toolsetGaps` is RUNTIME — the handler list a worker is actually about to
 *   receive, after stage narrowing, capability gating, the read-only strip and
 *   the small-model cap. The static check cannot see any of those, and each of
 *   them can take away the one tool the stage's purpose depends on.
 *
 * Both answer the same question against the same tool sets the evidence gate
 * counts with, so a stage can never be refused for a capability the gate would
 * not have demanded, nor pass a check the gate then fails it on.
 */

import { COMMAND_TOOLS, FILE_CHANGE_TOOLS } from '@/core/tool-executor';
import { ROLE_CONFIGS } from './roles';
import type { StageTemplate } from './templates';
import type { AgentRole } from './types';

/**
 * What a caller says the work IS. The same two declarations the evidence gate
 * judges after the fact (`StageDeclaration`), minus `readOnly` — a role can
 * always decline to write, so "read only" needs no capability.
 */
export interface DeclaredPurpose {
  producesArtifacts?: boolean;
  runsCommands?: boolean;
}

/** Tool GROUPS (role-config granularity) that can put bytes on disk. */
const WRITE_GROUPS = ['filesystem', 'shell'];
/** Tool GROUP that can execute. Matches `COMMAND_TOOLS` at handler granularity. */
const COMMAND_GROUP = 'shell';

/**
 * What a role is declared able to do, from its config alone.
 *
 * `readOnly` beats the toolset: the flag strips the file-mutating handlers, and
 * the shell escape hatch it leaves behind (`echo > file`) is a documented
 * ceiling of that defense, not a capability a stage may be built on.
 */
export function roleCapabilities(
  role: AgentRole,
  /**
   * A stage's own `toolIds`, which NARROW the role's set (worker-spawner). A
   * stage that declares `runsCommands` and then narrows the shell away is as
   * doomed as one whose role never had it.
   */
  narrowTo?: string[],
): { writesFiles: boolean; runsCommands: boolean } {
  const config = ROLE_CONFIGS[role];
  // An unknown role resolves to `general` at spawn time; mirror that here
  // rather than reporting a role with no capabilities at all.
  let toolIds = (config ?? ROLE_CONFIGS.general)?.toolIds ?? [];
  if (narrowTo?.length) {
    // A stage may name a GROUP (`shell`) or a single handler (`shell__run`) —
    // `spawnWorker` accepts both, so the same id must survive narrowing here or
    // the static check would refuse a stage that runs perfectly well.
    toolIds = toolIds.filter((id) => narrowTo.some((n) => n === id || n.startsWith(`${id}__`)));
  }
  return {
    writesFiles: !config?.readOnly && WRITE_GROUPS.some((g) => toolIds.includes(g)),
    runsCommands: toolIds.includes(COMMAND_GROUP),
  };
}

/**
 * Static check: does every stage's role support what the stage declares it is
 * for? One message per violation, in template order, so a bad template reports
 * all of its problems at once like the other validators here.
 *
 * `human_input` stages are skipped — no worker runs them, so they have no arm
 * to hold to a contract.
 */
export function stageContractErrors(stages: StageTemplate[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    if (s.stageType === 'human_input') continue;
    const caps = roleCapabilities(s.role, s.toolIds);
    if (s.producesArtifacts && !caps.writesFiles) {
      errors.push(
        `stage ${i + 1} ("${s.name}") declares producesArtifacts, but role '${s.role}' cannot write files` +
          `${ROLE_CONFIGS[s.role]?.readOnly ? ' (the role is read-only)' : ''}` +
          `${s.toolIds?.length ? ` under its declared toolIds [${s.toolIds.join(', ')}]` : ''}`,
      );
    }
    if (s.runsCommands && !caps.runsCommands) {
      errors.push(
        `stage ${i + 1} ("${s.name}") declares runsCommands, but role '${s.role}' has no shell tool` +
          `${s.toolIds?.length ? ` under its declared toolIds [${s.toolIds.join(', ')}]` : ''}`,
      );
    }
  }
  return errors;
}

/**
 * Runtime check: can THIS toolset honor the declared purpose? Returns one
 * reason per unmet declaration, empty when the contract holds.
 *
 * A writing purpose accepts either a file-mutating handler or the shell — the
 * evidence gate credits work done through `sed -i` or a heredoc, so refusing a
 * shell-only worker here would fail a stage the gate would have passed.
 */
export function toolsetGaps(purpose: DeclaredPurpose, toolNames: Iterable<string>): string[] {
  const names = new Set(toolNames);
  const hasCommands = [...COMMAND_TOOLS].some((t) => names.has(t));
  const hasWrites = hasCommands || [...FILE_CHANGE_TOOLS].some((t) => names.has(t));

  const gaps: string[] = [];
  if (purpose.producesArtifacts && !hasWrites) {
    gaps.push('declares producesArtifacts but holds no file-writing or shell tool');
  }
  if (purpose.runsCommands && !hasCommands) {
    gaps.push('declares runsCommands but holds no shell tool');
  }
  return gaps;
}
