/**
 * The shipped presets must compile to a loop that can actually run.
 *
 * This repo's recurring failure is not a broken mechanism, it is a working
 * mechanism nothing reaches. `stageType: 'qa_validation'` existed for months
 * with the retry loop behind it fully built and tested, and no shipped template
 * set the flag — so `rubberStampRate` read empty because the gate was
 * unreachable, not because nobody ran a pipeline. Same shape as the four
 * unreachable gates named in the rebuild plan.
 *
 * So these assert the property on the SEEDED CONTENT rather than on a fixture:
 * every preset compiles, validates, and — where it claims to verify work — has
 * the back-edge that makes the claim true.
 */
import { describe, expect, test } from 'vitest';
import { PRESET_TEMPLATES } from '@/db/seed-presets';
import { compileTemplateToGraph, nodeKeyFor, validateGraph } from './pipeline-graph';
import { stepConfigToStageTemplate } from './templates';

const presets = PRESET_TEMPLATES.filter((p) => Array.isArray(p.steps) && p.steps.length > 0);

const graphOf = (preset: (typeof presets)[number]) =>
  compileTemplateToGraph(preset.steps.map(stepConfigToStageTemplate));

describe('shipped pipeline presets', () => {
  test('there are presets to check', () => {
    // Without this the loop below vacuously passes if the export ever empties.
    expect(presets.length).toBeGreaterThan(0);
  });

  test.each(presets.map((p) => [p.name, p] as const))('%s compiles to a valid graph', (_name, preset) => {
    // `validateGraph` catches exactly the defects that are an infinite loop or
    // silently skipped work at runtime, and `createAndRun` refuses to run a
    // graph it rejects — so a preset failing here cannot be run at all.
    expect(validateGraph(graphOf(preset))).toEqual([]);
  });

  test.each(presets.map((p) => [p.name, p] as const))(
    '%s: every qa_validation stage has a bounded way back',
    (_name, preset) => {
      const graph = graphOf(preset);
      preset.steps.forEach((step, i) => {
        if (step.stageType !== 'qa_validation') return;
        const from = nodeKeyFor(i);
        const back = graph.edges.find((e) => e.from === from && e.condition === 'qa_fail');
        // A QA stage with no route back can reject work and do nothing about
        // it — the auditor becomes a reporter, which is the state this whole
        // effort started from.
        expect(back, `${step.name} declares qa_validation but has no qa_fail edge`).toBeDefined();
        expect(back?.maxTraversals, `${step.name}'s retry edge is unbounded`).toBeGreaterThan(0);
        // It must send work somewhere that can fix it, not to itself.
        expect(back?.to).not.toBe(from);
      });
    },
  );

  test('the Full Development Cycle is a real per-item loop, not a chain', () => {
    // The named preset, asserted specifically: this is the one a user gets for
    // "implement the open points", and the properties below are what make that
    // request come back verified instead of merely finished.
    const preset = presets.find((p) => p.name === 'Full Development Cycle');
    expect(preset, 'the Full Development Cycle preset must ship').toBeDefined();
    const graph = graphOf(preset!);

    // A foreach head, with the build/verify stages inside it.
    const foreach = graph.nodes.find((n) => n.kind === 'foreach');
    expect(foreach).toBeDefined();
    const body = graph.nodes.filter((n) => n.parentKey === foreach!.key).map((n) => n.name);
    expect(body).toContain('Implementation');
    expect(body).toContain('QA Validation');

    // And QA sends a rejected item back to the stage that owns the code —
    // re-running the reviewer would re-review an unchanged tree.
    const qaIndex = preset!.steps.findIndex((s) => s.stageType === 'qa_validation');
    const back = graph.edges.find((e) => e.from === nodeKeyFor(qaIndex) && e.condition === 'qa_fail');
    const target = graph.nodes.find((n) => n.key === back?.to);
    expect(target?.name).toBe('Implementation');
  });

  test('a preset that produces no plan declares no loop body', () => {
    // `loopOverPlan` with nothing to iterate is a stage that never runs. The
    // contract check enforces this at run time; asserting it on shipped content
    // means a bad preset cannot reach an install in the first place.
    for (const preset of presets) {
      const loops = preset.steps.some((s) => s.loopOverPlan);
      const plans = preset.steps.some((s) => s.producesPlan);
      if (loops) {
        expect(plans, `${preset.name} loops over a plan no stage produces`).toBe(true);
      }
    }
  });
});
