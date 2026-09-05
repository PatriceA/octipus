/**
 * Seed a `Full Development Cycle (CLI)` template: the shipped seven-stage
 * recipe with every stage pinned to a CLI agent by size of the job —
 * `cli/claude` for the big ones, `cli/gemini` (the `agy` binary) for the
 * medium ones, `cli/codex` for the small one.
 *
 * A separate template rather than an edit to the preset, so the shipped
 * recipe keeps working and the two can be compared on the same task. The
 * per-stage `model` override is the highest-precedence branch of
 * `resolveStageModel`, so these pins also outrank the `mechanical`
 * planner→executor routing — deliberate: the point of this run is to measure
 * the CLI agents, not the local executor.
 *
 *   npx tsx scripts/seed-cli-pipeline.ts
 */
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '@/db/postgres';
import type { PipelineStepConfig } from '@/db/schema/pipeline-templates';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';

const TEMPLATE_NAME = 'Full Development Cycle (CLI)';
const SOURCE_NAME = 'Full Development Cycle';

/** Stage name → CLI model, by how big the stage's job is. */
const AGENT_BY_STAGE: Record<string, string> = {
  'Research & Discovery': 'cli/gemini', // medium — agy
  'Requirements & Architecture': 'cli/claude', // big — design decisions
  Implementation: 'cli/claude', // big — writes the product
  Testing: 'cli/gemini', // medium — agy
  'Code Review': 'cli/gemini', // medium — agy
  'QA Validation': 'cli/gemini', // medium — agy
  'Summary & Handoff': 'cli/codex', // small — restates finished work
};

const db = getDb();

const [source] = await db
  .select()
  .from(pipelineTemplates)
  .where(eq(pipelineTemplates.name, SOURCE_NAME))
  .limit(1);

if (!source) {
  throw new Error(`No '${SOURCE_NAME}' template to copy — start the backend once so presets seed.`);
}

const steps: PipelineStepConfig[] = (source.steps as PipelineStepConfig[]).map((step) => {
  const model = AGENT_BY_STAGE[step.name];
  if (!model) throw new Error(`No CLI agent chosen for stage '${step.name}' — add one to AGENT_BY_STAGE.`);
  return { ...step, model };
});

const [existing] = await db
  .select({ id: pipelineTemplates.id })
  .from(pipelineTemplates)
  .where(eq(pipelineTemplates.name, TEMPLATE_NAME))
  .limit(1);

if (existing) {
  await db
    .update(pipelineTemplates)
    // `parameters` travels with the steps it belongs to: a step can reference
    // `{{param.x}}`, and a clone that took the steps without the declarations
    // would expand nothing — leaving a literal `{{param.verifyCommand}}` for
    // the framework to run as a command.
    .set({ steps, parameters: source.parameters, description: source.description, updatedAt: new Date() })
    .where(eq(pipelineTemplates.id, existing.id));
  console.log(`updated '${TEMPLATE_NAME}'`);
} else {
  await db.insert(pipelineTemplates).values({
    name: TEMPLATE_NAME,
    description: `${source.description} All stages run on CLI agents.`,
    isPreset: false,
    userId: null as never,
    steps,
    parameters: source.parameters,
  });
  console.log(`seeded '${TEMPLATE_NAME}'`);
}

for (const step of steps) console.log(`  ${step.name.padEnd(30)} ${step.model}`);
await closeDb();
