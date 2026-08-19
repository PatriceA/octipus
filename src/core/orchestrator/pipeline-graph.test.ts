import { describe, expect, test } from 'bun:test';
import {
  compileTemplateToGraph,
  edgeId,
  isRetryExhausted,
  nodeKeyFor,
  selectEdge,
  validateGraph,
} from './pipeline-graph';
import { PRESET_TEMPLATES } from '@/db/seed-presets';
import { stepConfigToStageTemplate, type StageTemplate } from './templates';

const step = (name: string, extra: Partial<StageTemplate> = {}): StageTemplate => ({
  name,
  role: 'coding',
  requiresApproval: false,
  promptTemplate: 'do {{description}}',
  ...extra,
});

/** The shape this whole feature exists for. */
const devTemplate = (): StageTemplate[] => [
  step('Research', { role: 'research' }),
  step('Architecture', { role: 'architecture', producesPlan: true, requiresApproval: true }),
  step('Implementation', { loopOverPlan: true, producesArtifacts: true }),
  step('Review', { role: 'review', loopOverPlan: true, readOnly: true }),
  step('QA', { role: 'qa', loopOverPlan: true, stageType: 'qa_validation', maxRetries: 2 }),
  step('Summary', { role: 'writing' }),
];

describe('compileTemplateToGraph — chain', () => {
  test('plain steps compile to an unconditional chain', () => {
    const g = compileTemplateToGraph([step('A'), step('B'), step('C')]);
    expect(g.entryKey).toBe(nodeKeyFor(0));
    expect(g.nodes.map((n) => n.key)).toEqual(['n0', 'n1', 'n2']);
    expect(g.edges).toEqual([
      { from: 'n0', to: 'n1', condition: 'always', ordinal: 0 },
      { from: 'n1', to: 'n2', condition: 'always', ordinal: 0 },
    ]);
    expect(validateGraph(g)).toEqual([]);
  });

  test('the last step has no outgoing edge — the walk ends there', () => {
    const g = compileTemplateToGraph([step('A'), step('B')]);
    expect(selectEdge(g, 'n1', 'ok')).toBeNull();
  });
});

describe('compileTemplateToGraph — QA cycle', () => {
  const g = compileTemplateToGraph([
    step('Plan', { role: 'architecture' }),
    step('Implement'),
    step('QA', { role: 'qa', stageType: 'qa_validation', maxRetries: 2 }),
    step('Ship'),
  ]);

  test('a passing verdict goes forward', () => {
    expect(selectEdge(g, 'n2', 'qa_pass')?.to).toBe('n3');
  });

  test('a failing verdict goes BACKWARD to the implementer, bounded', () => {
    const e = selectEdge(g, 'n2', 'qa_fail');
    expect(e?.to).toBe('n1');
    expect(e?.maxTraversals).toBe(2);
  });

  test('an unaccountable verdict re-runs the auditor alone, not the implementer', () => {
    expect(selectEdge(g, 'n2', 'audit_gate_failed')?.to).toBe('n2');
  });

  test('an exhausted retry edge stops being selectable', () => {
    const retry = selectEdge(g, 'n2', 'qa_fail')!;
    const used = new Map([[edgeId(retry), 2]]);
    expect(selectEdge(g, 'n2', 'qa_fail', used)).toBeNull();
    expect(isRetryExhausted(g, 'n2', used)).toBe(true);
    // ...and the pass edge is still there for the escalation path to take.
    expect(selectEdge(g, 'n2', 'qa_pass', used)?.to).toBe('n3');
  });

  test('every cycle it emits is bounded', () => {
    expect(validateGraph(g)).toEqual([]);
  });
});

describe('compileTemplateToGraph — plan loop', () => {
  const g = compileTemplateToGraph(devTemplate());

  test('consecutive loopOverPlan steps become ONE foreach node', () => {
    const foreaches = g.nodes.filter((n) => n.kind === 'foreach');
    expect(foreaches).toHaveLength(1);
    expect(g.nodes.filter((n) => n.parentKey === foreaches[0].key).map((n) => n.name))
      .toEqual(['Implementation', 'Review', 'QA']);
  });

  test('the architect leads into the loop head, not into the first body node', () => {
    const loopKey = g.nodes.find((n) => n.kind === 'foreach')!.key;
    expect(selectEdge(g, 'n1', 'ok')?.to).toBe(loopKey);
  });

  test('the loop head opens the body and, when the plan is done, exits', () => {
    const loopKey = g.nodes.find((n) => n.kind === 'foreach')!.key;
    expect(selectEdge(g, loopKey, 'loop_next')?.to).toBe('n2');
    expect(selectEdge(g, loopKey, 'loop_done')?.to).toBe('n5');
  });

  test('the last body node returns to the head to pick up the next item', () => {
    const loopKey = g.nodes.find((n) => n.kind === 'foreach')!.key;
    expect(selectEdge(g, 'n4', 'qa_pass')?.to).toBe(loopKey);
  });

  // Sending a per-item failure back to Architecture would re-plan the entire
  // pipeline over one bad item.
  test('a QA failure inside the loop stays inside the loop', () => {
    expect(selectEdge(g, 'n4', 'qa_fail')?.to).toBe('n2');
  });

  test('the compiled dev pipeline validates', () => {
    expect(validateGraph(g)).toEqual([]);
  });
});

describe('validateGraph', () => {
  test('rejects an unbounded backward edge', () => {
    const g = compileTemplateToGraph([step('A'), step('B')]);
    g.edges.push({ from: 'n1', to: 'n0', condition: 'always', ordinal: 1 });
    expect(validateGraph(g)).toEqual([
      "backward edge 'n1' -> 'n0' has no maxTraversals (unbounded cycle)",
    ]);
  });

  test('rejects an unreachable node — silently skipped work is not a pass', () => {
    const g = compileTemplateToGraph([step('A'), step('B')]);
    g.edges = [];
    expect(validateGraph(g)).toEqual(["node 'n1' is unreachable from the entry"]);
  });

  test('rejects an edge pointing at a node that does not exist', () => {
    const g = compileTemplateToGraph([step('A')]);
    g.edges.push({ from: 'n0', to: 'nope', condition: 'always', ordinal: 0 });
    expect(validateGraph(g)).toContain("edge to unknown node 'nope'");
  });
});

// The shipped presets are the templates that actually run. A preset that
// compiles to an invalid graph would only be discovered halfway through a paid
// run, so it is checked here instead.
describe('shipped presets compile to runnable graphs', () => {
  const presets = PRESET_TEMPLATES;

  for (const preset of presets) {
    test(`${preset.name} compiles and validates`, () => {
      const g = compileTemplateToGraph(preset.steps.map(stepConfigToStageTemplate));
      expect(validateGraph(g)).toEqual([]);
    });
  }

  test('Full Development Cycle loops implement -> test -> review -> QA per plan item', () => {
    const dev = presets.find((p) => p.name === 'Full Development Cycle')!;
    const g = compileTemplateToGraph(dev.steps.map(stepConfigToStageTemplate));
    const loop = g.nodes.find((n) => n.kind === 'foreach');
    expect(loop).toBeDefined();
    expect(g.nodes.filter((n) => n.parentKey === loop!.key).map((n) => n.name)).toEqual([
      'Implementation',
      'Testing',
      'Code Review',
      'QA Validation',
    ]);
    // Exactly one step writes the plan the loop consumes.
    expect(dev.steps.filter((s) => s.producesPlan).map((s) => s.name)).toEqual([
      'Requirements & Architecture',
    ]);
  });
  test('an empty template is a validation error, not a crash', () => {
    const g = compileTemplateToGraph([]);
    expect(validateGraph(g)).toEqual(['graph has no nodes']);
  });

  test('a loop body edge is identifiable, so retry budgets can reset per plan item', () => {
    const dev = presets.find((p) => p.name === 'Full Development Cycle')!;
    const g = compileTemplateToGraph(dev.steps.map(stepConfigToStageTemplate));
    const loop = g.nodes.find((n) => n.kind === 'foreach')!;
    const bodyKeys = new Set(g.nodes.filter((n) => n.parentKey === loop.key).map((n) => n.key));
    const bodyEdges = g.edges.filter((e) => bodyKeys.has(e.from));
    // The QA retry edge inside the body is the one whose budget must reset.
    expect(bodyEdges.some((e) => e.condition === 'qa_fail' && e.maxTraversals != null)).toBe(true);
    // ...and nothing outside the body is caught by that same filter.
    expect(bodyEdges.every((e) => bodyKeys.has(e.from))).toBe(true);
  });
  test('a human_input step compiles to a human node that still chains', () => {
    const g = compileTemplateToGraph([
      { name: 'Draft', role: 'coding', requiresApproval: false, promptTemplate: 'do it' },
      { name: 'Sign off?', role: 'general', requiresApproval: false, promptTemplate: 'ok?', stageType: 'human_input' },
      { name: 'Ship', role: 'coding', requiresApproval: false, promptTemplate: 'ship it' },
    ]);
    expect(validateGraph(g)).toEqual([]);
    expect(g.nodes.map((n) => n.kind)).toEqual(['step', 'human', 'step']);
    // It is a node in the chain, not a flag on one: work flows through it.
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['n0->n1', 'n1->n2']);
  });
});
