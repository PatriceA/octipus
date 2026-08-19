/**
 * The pipeline execution graph — compilation, validation, and edge selection.
 *
 * Everything here is PURE: it turns a template into nodes and edges, checks the
 * result, and answers "given this node and this outcome, where next?". No DB,
 * no workers, no LLM. `pipeline-manager.ts` owns the effects and calls into
 * this for every routing decision, which is what makes the routing testable
 * without booting an agent.
 *
 * Why a graph at all: the old model was a list — `stage_index` walked by
 * `currentStageIndex` — so the one cycle that mattered (QA sends work back to
 * the implementer) had to be special-cased as a `while` loop nested inside the
 * stage loop, and the loop everyone actually wanted (run the implement → review
 * → QA span once per plan item) could not be expressed at all.
 */
import type { StageTemplate } from './templates';

export type NodeKind = 'step' | 'foreach';

export type EdgeCondition =
  | 'always'
  | 'qa_pass'
  | 'qa_fail'
  | 'audit_gate_failed'
  | 'loop_body'
  | 'loop_done'
  | 'on_error';

/**
 * What a node reported. Drives edge selection, one-to-one with the conditions
 * above except `ok`, which matches an `always` edge.
 */
export type NodeOutcome =
  | 'ok'
  | 'qa_pass'
  | 'qa_fail'
  | 'audit_gate_failed'
  | 'loop_next'
  | 'loop_done'
  | 'error';

export interface GraphNode {
  key: string;
  kind: NodeKind;
  name: string;
  /** Index into `template.stages`, or -1 for a node the compiler synthesized. */
  templateIndex: number;
  /** The `foreach` head that owns this node, when it is a loop body node. */
  parentKey?: string;
  ordinal: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  condition: EdgeCondition;
  /** Traversal bound. Required on every backward edge; a cycle without one runs forever. */
  maxTraversals?: number;
  ordinal: number;
}

export interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Where the walk starts. */
  entryKey: string;
}

/** Stable per-template node key. Position-based, so a re-compile is identical. */
export const nodeKeyFor = (templateIndex: number) => `n${templateIndex}`;
const loopKeyFor = (firstBodyIndex: number) => `loop${firstBodyIndex}`;

/**
 * Compile a template into a graph.
 *
 * Three shapes come out of this, and nothing else — the compiler is
 * deliberately not a general graph editor:
 *
 * 1. **Chain.** Consecutive plain steps get one unconditional edge each. This is
 *    every pipeline that exists today, unchanged.
 * 2. **QA cycle.** A `qa_validation` step gets three edges instead of one:
 *    `qa_pass` forward, `qa_fail` BACKWARD to its retry target (bounded by the
 *    step's `maxRetries`), and `audit_gate_failed` to ITSELF — the auditor
 *    re-runs alone when the verdict, not the work, was rejected.
 * 3. **Plan loop.** A maximal run of consecutive steps declaring `loopOverPlan`
 *    becomes the body of one synthesized `foreach` node. No nesting syntax: the
 *    grouping IS the declaration, so a template author marks the steps that
 *    repeat and nothing else.
 */
export function compileTemplateToGraph(stages: StageTemplate[]): PipelineGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let ordinal = 0;

  // Group consecutive `loopOverPlan` steps. `segments` is the top-level
  // sequence: either a single step, or a loop covering a span of steps.
  type Segment =
    | { kind: 'step'; index: number }
    | { kind: 'loop'; key: string; indices: number[] };
  const segments: Segment[] = [];
  for (let i = 0; i < stages.length; i++) {
    if (!stages[i].loopOverPlan) {
      segments.push({ kind: 'step', index: i });
      continue;
    }
    const indices: number[] = [];
    const start = i;
    while (i < stages.length && stages[i].loopOverPlan) indices.push(i++);
    i--; // the for-loop increments again
    segments.push({ kind: 'loop', key: loopKeyFor(start), indices });
  }

  const pushStep = (index: number, parentKey?: string) => {
    nodes.push({
      key: nodeKeyFor(index),
      kind: 'step',
      name: stages[index].name,
      templateIndex: index,
      parentKey,
      ordinal: ordinal++,
    });
  };

  for (const seg of segments) {
    if (seg.kind === 'step') {
      pushStep(seg.index);
    } else {
      nodes.push({
        key: seg.key,
        kind: 'foreach',
        name: `For each plan item`,
        templateIndex: -1,
        ordinal: ordinal++,
      });
      for (const index of seg.indices) pushStep(index, seg.key);
    }
  }

  /** Entry key of a segment — for a loop that is the `foreach` head. */
  const headOf = (seg: Segment) => (seg.kind === 'step' ? nodeKeyFor(seg.index) : seg.key);

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const next = segments[s + 1];
    const exitTo = next ? headOf(next) : undefined;

    if (seg.kind === 'loop') {
      const bodyKeys = seg.indices.map(nodeKeyFor);
      edges.push({ from: seg.key, to: bodyKeys[0], condition: 'loop_body', ordinal: 0 });
      if (exitTo) edges.push({ from: seg.key, to: exitTo, condition: 'loop_done', ordinal: 1 });
      // Body: chain, then the last body node returns to the loop head to pick
      // up the next item. Unbounded on purpose — the bound is the plan itself
      // (an item is marked done per pass), not a traversal counter.
      for (let b = 0; b < seg.indices.length; b++) {
        const index = seg.indices[b];
        const isLast = b === seg.indices.length - 1;
        const forwardTo = isLast ? seg.key : nodeKeyFor(seg.indices[b + 1]);
        pushStageEdges(edges, stages, index, forwardTo, seg.indices);
      }
      continue;
    }

    // Plain step. A trailing step with no successor simply has no edge — the
    // walk ends there.
    pushStageEdges(edges, stages, seg.index, exitTo, undefined);
  }

  // An empty template compiles to an empty graph rather than throwing, so
  // `validateGraph` gets to report it ('graph has no nodes') like every other
  // structural defect.
  return { nodes, edges, entryKey: segments.length > 0 ? headOf(segments[0]) : '' };
}

/**
 * Edges leaving one step. A QA step emits the retry cycle; anything else emits
 * a single unconditional forward edge.
 */
function pushStageEdges(
  edges: GraphEdge[],
  stages: StageTemplate[],
  index: number,
  forwardTo: string | undefined,
  loopIndices: number[] | undefined,
): void {
  const stage = stages[index];
  const from = nodeKeyFor(index);

  if (stage.stageType !== 'qa_validation') {
    if (forwardTo) edges.push({ from, to: forwardTo, condition: 'always', ordinal: 0 });
    return;
  }

  // Retry target: the step's explicit choice always wins. Without one, a plain
  // chain falls back to the previous step (today's contract), but inside a loop
  // the default is the FIRST body node — the one that owns the work. The
  // previous step there is typically a reviewer, and re-running a reviewer does
  // not fix what QA rejected. The target must also stay inside the body:
  // sending a per-item failure back to a step that ran before the loop would
  // re-plan the entire pipeline over one bad item.
  let target = stage.retryTargetStage ?? (loopIndices ? loopIndices[0] : index - 1);
  if (loopIndices && !loopIndices.includes(target)) target = loopIndices[0];
  if (target < 0) target = index;

  if (forwardTo) {
    edges.push({ from, to: forwardTo, condition: 'qa_pass', ordinal: 0 });
  }
  edges.push({
    from,
    to: nodeKeyFor(target),
    condition: 'qa_fail',
    maxTraversals: stage.maxRetries ?? 3,
    ordinal: 1,
  });
  // The verdict was unaccountable, not the work wrong: re-run the auditor only.
  edges.push({
    from,
    to: from,
    condition: 'audit_gate_failed',
    maxTraversals: stage.maxRetries ?? 3,
    ordinal: 2,
  });
}

/**
 * Structural validation. Runs before a graph is persisted, because every defect
 * here is an infinite loop or a stranded node at runtime.
 */
export function validateGraph(graph: PipelineGraph): string[] {
  const errors: string[] = [];
  const keys = new Set(graph.nodes.map((n) => n.key));
  if (graph.nodes.length === 0) return ['graph has no nodes'];
  if (!keys.has(graph.entryKey)) errors.push(`entry node '${graph.entryKey}' does not exist`);
  if (keys.size !== graph.nodes.length) errors.push('duplicate node keys');

  for (const e of graph.edges) {
    if (!keys.has(e.from)) errors.push(`edge from unknown node '${e.from}'`);
    if (!keys.has(e.to)) errors.push(`edge to unknown node '${e.to}'`);
  }

  // Reachability from the entry — a node nothing points at never runs, which is
  // silently-skipped work rather than a loud failure.
  const reachable = new Set([graph.entryKey]);
  const queue = [graph.entryKey];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const e of graph.edges.filter((x) => x.from === cur)) {
      if (!reachable.has(e.to)) { reachable.add(e.to); queue.push(e.to); }
    }
  }
  for (const n of graph.nodes) {
    if (!reachable.has(n.key)) errors.push(`node '${n.key}' is unreachable from the entry`);
  }

  // Every cycle must be bounded. A `foreach` head bounds its own cycle by
  // consuming plan items, so a loop-body return edge is exempt; any OTHER
  // backward edge needs an explicit `maxTraversals`.
  const foreachKeys = new Set(graph.nodes.filter((n) => n.kind === 'foreach').map((n) => n.key));
  const ordinalOf = new Map(graph.nodes.map((n) => [n.key, n.ordinal]));
  for (const e of graph.edges) {
    const backward = (ordinalOf.get(e.to) ?? 0) <= (ordinalOf.get(e.from) ?? 0);
    if (!backward) continue;
    if (foreachKeys.has(e.to)) continue;
    if (e.maxTraversals == null) {
      errors.push(`backward edge '${e.from}' -> '${e.to}' has no maxTraversals (unbounded cycle)`);
    }
  }
  return errors;
}

const MATCHES: Record<NodeOutcome, EdgeCondition[]> = {
  // A plain success takes the unconditional edge.
  ok: ['always'],
  // A passing verdict prefers its own edge, but a QA step in a template that
  // never declared one still needs to move on.
  qa_pass: ['qa_pass', 'always'],
  qa_fail: ['qa_fail'],
  audit_gate_failed: ['audit_gate_failed'],
  loop_next: ['loop_body'],
  loop_done: ['loop_done', 'always'],
  error: ['on_error'],
};

/**
 * Pick the edge to follow. Returns null when nothing matches — which the caller
 * must treat as "the walk ends here", never as "carry on somehow".
 *
 * `traversals` is the live per-edge count; an edge at its `maxTraversals` is
 * skipped, so an exhausted retry falls through to the next matching condition
 * (in practice: to the escalation path) instead of looping forever.
 */
export function selectEdge(
  graph: PipelineGraph,
  from: string,
  outcome: NodeOutcome,
  traversals: Map<string, number> = new Map(),
): GraphEdge | null {
  const conditions = MATCHES[outcome];
  const candidates = graph.edges
    .filter((e) => e.from === from)
    .sort((a, b) => a.ordinal - b.ordinal);

  for (const condition of conditions) {
    for (const e of candidates) {
      if (e.condition !== condition) continue;
      const used = traversals.get(edgeId(e)) ?? 0;
      if (e.maxTraversals != null && used >= e.maxTraversals) continue;
      return e;
    }
  }
  return null;
}

/** Stable identity for one edge — same triple the DB row is keyed on. */
export const edgeId = (e: GraphEdge) => `${e.from}->${e.to}:${e.condition}`;

/** True when a retry edge exists but has been used up. Drives QA escalation. */
export function isRetryExhausted(
  graph: PipelineGraph,
  from: string,
  traversals: Map<string, number>,
): boolean {
  const retry = graph.edges.find((e) => e.from === from && e.condition === 'qa_fail');
  if (!retry || retry.maxTraversals == null) return false;
  return (traversals.get(edgeId(retry)) ?? 0) >= retry.maxTraversals;
}
