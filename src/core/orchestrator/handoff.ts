import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';

export interface HandoffContext {
  /** Unique handoff ID for tracing */
  id: string;
  /** Timestamp of handoff */
  timestamp: Date;
  /** Source stage/agent info */
  from: {
    role: string;
    stageName?: string;
    stageIndex?: number;
  };
  /** Target stage/agent info */
  to: {
    role: string;
    stageName?: string;
    stageIndex?: number;
  };
  /** Original user request */
  originalRequest: string;
  /** Summary of what was accomplished */
  completedWork: string;
  /** Key decisions made */
  decisions: string[];
  /** Open questions or concerns */
  openQuestions: string[];
  /** Artifacts produced (file paths, URLs, etc.) */
  artifacts: string[];
  /** Specific instructions for next stage */
  instructions: string;
}

// ── Patterns for extracting structured info from raw output ──────

const FILE_PATH_PATTERN = /(?:^|\s)((?:\/[\w.-]+)+(?:\.\w+)?|(?:\.\/|\.\.\/)?(?:[\w.-]+\/)+[\w.-]+(?:\.\w+)?)/gm;
const URL_PATTERN = /https?:\/\/[^\s)>\]]+/g;
const DECISION_MARKERS = /(?:^|\n)\s*[-*]\s*(?:decided|chose|selected|opted|went with|using|will use|approach:|decision:)\s*/gi;
const QUESTION_MARKERS = /(?:^|\n)\s*[-*]\s*(?:TODO|FIXME|question:|unclear:|need to|should we|open question:|concern:)\s*/gi;

/**
 * Format a handoff context into a prompt-friendly markdown string.
 */
export function formatHandoff(handoff: HandoffContext): string {
  const sections: string[] = [];

  sections.push(`# Handoff: ${handoff.from.stageName || handoff.from.role} → ${handoff.to.stageName || handoff.to.role}`);
  sections.push(`_Handoff ID: ${handoff.id} | ${handoff.timestamp.toISOString()}_`);

  sections.push(`\n## Original Request\n${handoff.originalRequest}`);

  sections.push(`\n## Completed Work\n${handoff.completedWork}`);

  if (handoff.decisions.length > 0) {
    sections.push(`\n## Key Decisions Made\n${handoff.decisions.map(d => `- ${d}`).join('\n')}`);
  }

  if (handoff.openQuestions.length > 0) {
    sections.push(`\n## Open Questions / Concerns\n${handoff.openQuestions.map(q => `- ${q}`).join('\n')}`);
  }

  if (handoff.artifacts.length > 0) {
    sections.push(`\n## Artifacts Produced\n${handoff.artifacts.map(a => `- ${a}`).join('\n')}`);
  }

  if (handoff.instructions) {
    sections.push(`\n## Instructions for Next Stage\n${handoff.instructions}`);
  }

  return sections.join('\n');
}

/**
 * Format a chain of handoffs (accumulated across multiple stages).
 * Shows the full history so later stages understand the full journey.
 */
export function formatHandoffChain(handoffs: HandoffContext[]): string {
  if (handoffs.length === 0) return '';
  if (handoffs.length === 1) return formatHandoff(handoffs[0]);

  const sections: string[] = [];
  sections.push('# Pipeline Handoff Context (cumulative)');

  // Show original request once
  sections.push(`\n## Original Request\n${handoffs[0].originalRequest}`);

  // Summarize each prior stage
  sections.push('\n## Stage History');
  for (const handoff of handoffs) {
    sections.push(`\n### Stage: ${handoff.from.stageName || handoff.from.role} (${handoff.from.role})`);
    sections.push(handoff.completedWork);

    if (handoff.decisions.length > 0) {
      sections.push(`**Decisions:** ${handoff.decisions.join('; ')}`);
    }
    if (handoff.artifacts.length > 0) {
      sections.push(`**Artifacts:** ${handoff.artifacts.join(', ')}`);
    }
  }

  // Only show open questions from the latest handoff
  const latest = handoffs[handoffs.length - 1];
  if (latest.openQuestions.length > 0) {
    sections.push(`\n## Current Open Questions\n${latest.openQuestions.map(q => `- ${q}`).join('\n')}`);
  }

  if (latest.instructions) {
    sections.push(`\n## Instructions for Next Stage\n${latest.instructions}`);
  }

  return sections.join('\n');
}

/**
 * Create a handoff context by extracting structured info from raw stage output.
 * Uses regex/heuristics to avoid additional LLM calls.
 */
export async function createHandoffContext(params: {
  from: HandoffContext['from'];
  to: HandoffContext['to'];
  originalRequest: string;
  stageOutput: string;
}): Promise<HandoffContext> {
  const { from, to, originalRequest, stageOutput } = params;

  // Prefer a schema-enforced handoff block if the stage emitted one — exact
  // structure, no lossy regex. Fall back PER FIELD when the block omits one
  // (empty string/array is a miss, not a value), and say so loudly (fail loud).
  const structured = parseStructuredHandoff(stageOutput);
  const decisions = structured?.decisions.length ? structured.decisions : extractDecisions(stageOutput);
  const openQuestions = structured?.openQuestions.length ? structured.openQuestions : extractOpenQuestions(stageOutput);
  const artifacts = structured?.artifacts.length ? structured.artifacts : extractArtifacts(stageOutput);
  const completedWork = structured?.completedWork
    ? summarizeOutput(structured.completedWork)
    : summarizeOutput(stageOutput);
  // Always compute the built instructions — they carry the automatic
  // error/warning flag and role-transition hint the structured block won't.
  // The stage's own nextStageInstructions, if any, lead.
  const builtInstructions = buildInstructions(from, to, stageOutput);
  const instructions = [structured?.instructions, builtInstructions]
    .filter((s): s is string => !!s && s.length > 0)
    .join('\n\n');

  if (!structured) {
    coreLogger.info(
      { from: `${from.stageName || from.role}`, to: `${to.stageName || to.role}` },
      'handoff: no structured block found — fell back to prose extraction',
    );
  }

  const handoff: HandoffContext = {
    id: generateId(),
    timestamp: new Date(),
    from,
    to,
    originalRequest,
    completedWork,
    decisions,
    openQuestions,
    artifacts,
    instructions,
  };

  coreLogger.debug(
    {
      handoffId: handoff.id,
      from: `${from.stageName || from.role}`,
      to: `${to.stageName || to.role}`,
      structured: !!structured,
      decisionsCount: decisions.length,
      artifactsCount: artifacts.length,
      questionsCount: openQuestions.length,
    },
    'Created handoff context',
  );

  return handoff;
}

interface StructuredHandoff {
  decisions: string[];
  openQuestions: string[];
  artifacts: string[];
  instructions: string;
  completedWork: string;
}

const HANDOFF_ITEM_MAX = 500; // per-item char bound, matches the regex extractors

/**
 * Extract a schema-enforced handoff from a stage's output. Stages opt in ONLY
 * by emitting an explicit fenced ```handoff block — a generic ```json block is
 * NOT treated as a handoff (a doc/example block that happens to mention
 * "handoff" must not override real prose extraction). Returns null when absent
 * or malformed — the caller falls back to regex scraping. Every field is
 * coerced to the expected type and per-item length-bounded; embedded text is
 * DATA only (populates string arrays, never executes), narrowing the injection
 * surface a compromised stage can steer.
 */
export function parseStructuredHandoff(output: string): StructuredHandoff | null {
  const fenced = output.match(/```handoff\s*\n?([\s\S]*?)\n?```/);
  if (!fenced) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fenced[1].trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const h = raw as Record<string, unknown>;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string' && x.length > 0)
          .map((x) => x.slice(0, HANDOFF_ITEM_MAX))
          .slice(0, 20)
      : [];
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  return {
    decisions: strArray(h.decisions),
    openQuestions: strArray(h.openQuestions),
    artifacts: strArray(h.artifacts),
    // Accept either name — plan calls it nextStageInstructions.
    instructions: str(h.instructions) || str(h.nextStageInstructions),
    completedWork: str(h.completedWork),
  };
}

/**
 * Instruction appended to every NON-final pipeline stage so it emits the
 * ```handoff block `parseStructuredHandoff` consumes (Phase B3). The regex
 * extractors below stay as the loud fallback for stages (or models) that don't
 * produce the block.
 *
 * Deliberately describes the block as a FIELD LIST rather than embedding a
 * literal ```handoff example: an embedded example is itself a valid handoff, so
 * a weak model echoing the instruction verbatim would emit parseable placeholder
 * data. With no literal fence here, echoing the instruction yields nothing the
 * parser accepts — only a stage that actually authors its own block succeeds.
 */
export const HANDOFF_EMIT_INSTRUCTION = `

---
PIPELINE HANDOFF — after your normal report above, append a fenced code block tagged \`handoff\` (open the fence with three backticks immediately followed by the word handoff) containing ONLY a JSON object with YOUR real values for these fields:
- completedWork (string): 1-3 sentence summary of what THIS stage produced
- decisions (string[]): key decisions the next stage must respect
- artifacts (string[]): file paths / URLs you created or changed
- openQuestions (string[]): anything unresolved the next stage should address
- nextStageInstructions (string): explicit, actionable instruction for the next stage

Use [] for any list with nothing to report. Emit the block exactly once — do not copy these field descriptions. It is internal pipeline data (stripped before the user sees it); keep your prose report above it.`;

/**
 * Remove the machine-readable ```handoff block from a stage's output once the
 * handoff chain has been parsed from it — so the block (internal pipeline data)
 * is never persisted, shown to the user, or carried into the next stage's prose
 * context. Matches the same fence `parseStructuredHandoff` consumes.
 */
export function stripHandoffBlock(output: string): string {
  return output.replace(/```handoff\s*\n?[\s\S]*?\n?```/g, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// ── Internal extraction helpers ──────────────────────────────────

function extractDecisions(output: string): string[] {
  const decisions: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (DECISION_MARKERS.test(trimmed)) {
      // Reset regex lastIndex after test
      DECISION_MARKERS.lastIndex = 0;
      const cleaned = trimmed
        .replace(/^[-*]\s*/, '')
        .replace(/^(?:decided|chose|selected|opted|went with|using|will use|approach:|decision:)\s*/i, '')
        .trim();
      if (cleaned.length > 10 && cleaned.length < 500) {
        decisions.push(cleaned);
      }
    }
    DECISION_MARKERS.lastIndex = 0;
  }

  return decisions.slice(0, 10); // cap at 10 decisions
}

function extractOpenQuestions(output: string): string[] {
  const questions: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (QUESTION_MARKERS.test(trimmed)) {
      QUESTION_MARKERS.lastIndex = 0;
      const cleaned = trimmed
        .replace(/^[-*]\s*/, '')
        .replace(/^(?:TODO|FIXME|question:|unclear:|need to|should we|open question:|concern:)\s*/i, '')
        .trim();
      if (cleaned.length > 5 && cleaned.length < 500) {
        questions.push(cleaned);
      }
    }
    QUESTION_MARKERS.lastIndex = 0;
  }

  // Also capture lines ending with '?'
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith('?') && trimmed.length > 15 && trimmed.length < 300) {
      if (!questions.some(q => q === trimmed)) {
        questions.push(trimmed);
      }
    }
  }

  return questions.slice(0, 8); // cap
}

function extractArtifacts(output: string): string[] {
  const artifacts = new Set<string>();

  // File paths
  const fileMatches = output.matchAll(FILE_PATH_PATTERN);
  for (const match of fileMatches) {
    const path = match[1];
    // Filter out common false positives
    if (path && path.length > 3 && !path.startsWith('http') && !path.match(/^\d/)) {
      artifacts.add(path);
    }
  }

  // URLs
  const urlMatches = output.matchAll(URL_PATTERN);
  for (const match of urlMatches) {
    artifacts.add(match[0]);
  }

  return Array.from(artifacts).slice(0, 20); // cap
}

/**
 * Produce a concise summary of the output.
 * If the output is short, use it directly. Otherwise, take the first and last meaningful paragraphs.
 */
function summarizeOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= 2000) {
    return trimmed;
  }

  // Take first ~800 chars and last ~800 chars with ellipsis
  const firstPart = trimmed.slice(0, 800);
  const lastPart = trimmed.slice(-800);

  // Try to break at paragraph boundaries
  const firstBreak = firstPart.lastIndexOf('\n\n');
  const lastBreak = lastPart.indexOf('\n\n');

  const first = firstBreak > 200 ? firstPart.slice(0, firstBreak) : firstPart;
  const last = lastBreak > 0 && lastBreak < 600 ? lastPart.slice(lastBreak) : lastPart;

  return `${first}\n\n[... output truncated ...]\n${last}`;
}

/**
 * Build stage-transition instructions based on the roles involved.
 */
function buildInstructions(
  from: HandoffContext['from'],
  to: HandoffContext['to'],
  stageOutput: string,
): string {
  const instructions: string[] = [];

  // Role-specific transition guidance
  const transitionHints: Record<string, Record<string, string>> = {
    research: {
      coding: 'Use the research findings above to guide implementation. Focus on the recommended approach.',
      review: 'Review the research methodology and verify the conclusions are well-supported.',
      design: 'Use the research findings to inform design decisions.',
    },
    coding: {
      review: 'Review the code changes for correctness, style, and potential issues. List specific file paths and line numbers for any concerns.',
      qa: 'Test the implementation described above. Focus on edge cases and the specific requirements from the original request.',
      security: 'Audit the code changes for security vulnerabilities, injection risks, and authentication issues.',
    },
    review: {
      coding: 'Address the review feedback listed above. Fix each issue mentioned and explain what was changed.',
      qa: 'The code has been reviewed. Proceed with testing, paying attention to any concerns raised in the review.',
    },
    design: {
      coding: 'Implement the design as specified. Follow the component structure and patterns outlined above.',
    },
  };

  const hint = transitionHints[from.role]?.[to.role];
  if (hint) {
    instructions.push(hint);
  }

  // If output mentions errors or warnings, flag them
  if (/\b(?:error|warning|failed|failure)\b/i.test(stageOutput)) {
    instructions.push('Note: The previous stage output contains errors or warnings — review them carefully before proceeding.');
  }

  return instructions.join('\n');
}
