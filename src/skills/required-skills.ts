/**
 * Skills a worker gets IN FULL, not as an index line.
 *
 * Discovery (`discoverSkillIds`) only lists skills by name and description and
 * leaves loading them to the agent through `get_skill`. Agents — CLI agents
 * especially — mostly do not, so a skill a stage plainly needs went unread.
 * Two sources force one in:
 *
 * - **Declared**: a pipeline step's `skillIds`. The template author knows the
 *   stage needs it; a declared skill that is gone fails the spawn.
 * - **Decided**: with a step's `autoSkills`, the decision model (topic
 *   `decision`) judges each discovered skill against the task, one
 *   independent yes/no each, and only a confident yes is loaded. Nothing
 *   bound, a refused privacy gate or an unsure answer adds nothing — the
 *   skill stays in the index, as before.
 */
import type { SkillView } from '@/db/schema/skills';
import { decide, type DecisionSite } from '@/models/decision';
import { getSkillRegistry } from './registry';

/**
 * `secret`: a stage's task carries the workspace's code and the previous
 * stage's output, so it may only reach a local, no-retention decision model —
 * the same class as `pipeline.qa-verdict`. `minConfidence` 0 because every
 * skill is judged on its own; the per-skill bar is below.
 */
const SKILL_SITE: DecisionSite = { id: 'skills.select', sensitivity: 'secret', minConfidence: 0 };
/** A skill is loaded only on a confident yes: both the probability and the model's confidence. */
export const DECIDED_SKILL_MIN_P = 0.8;
/** Each candidate is one decision request on some routes; the best-ranked few are enough. */
export const DECIDED_SKILL_MAX_CANDIDATES = 8;

export interface DecidedSkill {
  id: string;
  name: string;
  p: number;
}

/** The candidates the decision model is confident the task needs, best first. */
export async function decideTaskSkills(task: string, role: string, candidates: SkillView[]): Promise<DecidedSkill[]> {
  const pool = candidates.slice(0, DECIDED_SKILL_MAX_CANDIDATES);
  if (pool.length === 0) return [];
  const questions = Object.fromEntries(pool.map((skill, i) => [`s${i + 1}`, {
    type: 'noul' as const,
    instructions: `Skill ${i + 1} ("${skill.name}") gives instructions this agent needs to do this task well.`,
    criteria: {
      true: 'the task is squarely the kind of work the skill describes',
      false: 'the skill is unrelated, only loosely related, or would merely be nice to have',
    },
  }]));
  const skills = Object.fromEntries(pool.map((skill, i) => [String(i + 1), `${skill.name}: ${(skill.description || '').slice(0, 400)}`]));
  const answers = await decide(SKILL_SITE, { role, task: task.slice(-8000), skills }, questions);
  if (!answers) return [];
  return pool
    .map((skill, i) => ({ skill, answer: answers[`s${i + 1}`] }))
    .filter(({ answer }) => answer?.type === 'noul' && answer.p >= DECIDED_SKILL_MIN_P && answer.confidence >= DECIDED_SKILL_MIN_P)
    .map(({ skill, answer }) => ({ id: skill.id, name: skill.name, p: (answer as { p: number }).p }))
    .sort((a, b) => b.p - a.p);
}

/**
 * The declared skills as rows, in declared order. Throws when one is not
 * visible to the user (deleted, hidden, or never theirs): a stage declared
 * to need a skill must not run without it.
 */
export async function resolveDeclaredSkills(skillIds: string[], userId: string | undefined): Promise<SkillView[]> {
  const registry = getSkillRegistry();
  const wanted = [...new Set(skillIds.map((id) => registry.canonicalId(id)))];
  const found = await registry.getByIds(wanted, userId);
  const byId = new Map(found.map((skill) => [skill.id, skill]));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(`Required skill${missing.length === 1 ? '' : 's'} unavailable: ${missing.join(', ')}. ` +
      `Update the pipeline step's skills before running it again.`);
  }
  return wanted.map((id) => byId.get(id) as SkillView);
}

/** The prompt section carrying the forced skills' full instructions; '' for none. */
export async function buildRequiredSkillsPrompt(skillIds: string[], userId: string | undefined): Promise<string> {
  if (skillIds.length === 0) return '';
  const content = await getSkillRegistry().buildPromptFragment(skillIds, userId);
  if (!content) return '';
  return '\n\n# Required skills\nThese skills were chosen for this task. Their complete instructions are loaded ' +
    'below: follow them while you work — you do not need to call get_skill for them. They do not grant ' +
    'additional tool permissions.\n\n' + content;
}
