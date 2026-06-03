/**
 * Pure report synthesis + citation linking (feature #5). Given gathered sources
 * and the model's raw section output, produce a ReportDoc where every citation
 * resolves to a real Source — invented/dangling citations are dropped, and
 * sections that end up with no support are flagged in `limitations` rather than
 * presented as fact. No I/O; fully testable.
 */
import { createHash } from 'node:crypto';
import type { ReportDoc, ReportSection, ResearchDepth, Source } from './types';

/** Build a Source with a stable id (from the URL) and a content hash. */
export function buildSource(url: string, title: string, content: string, retrievedAt: string): Source {
  const id = `s${createHash('sha256').update(url).digest('hex').slice(0, 8)}`;
  const hash = createHash('sha256').update(content).digest('hex');
  return { id, url, title: title.trim() || url, retrievedAt, hash };
}

/** A raw section as emitted by the synthesis model (citations may be invalid). */
export interface RawSection {
  heading: string;
  markdown: string;
  citations: string[];
}

export interface ResolveInput {
  question: string;
  depth: ResearchDepth;
  generatedAt: string;
  rawSections: RawSection[];
  sources: Source[];
  /** Limitations text the model produced (may be empty). */
  modelLimitations?: string;
}

/**
 * Resolve a raw synthesis into a verified ReportDoc:
 *  - drop citations that don't resolve to a gathered Source (no invented URLs),
 *  - drop empty sections,
 *  - keep sections with no valid citation but record the count in `limitations`
 *    (flagged, not silently presented as supported),
 *  - prune sources nothing cites so the bibliography matches the report.
 *
 * Throws if there are no sources at all — we fail loud rather than emit a
 * report with nothing behind it (DESIGN.md fail-loud spirit).
 */
export function resolveReport(input: ResolveInput): ReportDoc {
  if (input.sources.length === 0) {
    throw new Error('No sources were gathered — refusing to synthesize an uncited report.');
  }
  const sourceIds = new Set(input.sources.map((s) => s.id));

  let droppedRefs = 0;
  let uncitedSections = 0;
  const sections: ReportSection[] = [];

  for (const raw of input.rawSections) {
    const markdown = (raw.markdown ?? '').trim();
    if (!markdown) continue;
    const unique = Array.from(new Set(raw.citations ?? []));
    const valid = unique.filter((c) => sourceIds.has(c));
    droppedRefs += unique.length - valid.length;
    if (valid.length === 0) uncitedSections += 1;
    sections.push({ heading: (raw.heading ?? '').trim() || 'Findings', markdown, citations: valid });
  }

  // Keep only sources at least one surviving section cites.
  const cited = new Set(sections.flatMap((s) => s.citations));
  const sources = input.sources.filter((s) => cited.has(s.id));

  const notes: string[] = [];
  if (input.modelLimitations?.trim()) notes.push(input.modelLimitations.trim());
  if (uncitedSections > 0) {
    notes.push(`${uncitedSections} section(s) could not be tied to a specific source and should be treated as lower-confidence.`);
  }
  if (droppedRefs > 0) {
    notes.push(`${droppedRefs} citation(s) referencing unknown sources were removed.`);
  }
  if (notes.length === 0) notes.push('No major gaps identified, but findings are limited to the sources gathered.');

  return {
    question: input.question,
    generatedAt: input.generatedAt,
    depth: input.depth,
    sections,
    sources: sources.length > 0 ? sources : input.sources,
    limitations: notes.join(' '),
  };
}
