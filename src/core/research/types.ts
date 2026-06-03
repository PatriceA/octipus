/** Deep Research → cited report (feature #5). */
export type ResearchDepth = 'quick' | 'standard' | 'deep';

/** A fetched source, with a stable id and content hash so citations verify. */
export interface Source {
  id: string;
  url: string;
  title: string;
  /** ISO timestamp the source was retrieved. */
  retrievedAt: string;
  /** sha256 of the fetched content (verifiability). */
  hash: string;
}

/** One report section. `citations` are Source ids (resolved, never invented). */
export interface ReportSection {
  heading: string;
  markdown: string;
  citations: string[];
}

/** The synthesized, cited report. */
export interface ReportDoc {
  question: string;
  generatedAt: string;
  depth: ResearchDepth;
  sections: ReportSection[];
  sources: Source[];
  /** Honest statement of what could not be verified / gaps. */
  limitations: string;
}

/** Per-depth bounds on the investigation (fan-out width + sources). */
export const DEPTH_BUDGET: Record<ResearchDepth, { queries: number; sourcesPerQuery: number; maxSources: number }> = {
  quick: { queries: 1, sourcesPerQuery: 3, maxSources: 4 },
  standard: { queries: 2, sourcesPerQuery: 3, maxSources: 8 },
  deep: { queries: 4, sourcesPerQuery: 4, maxSources: 14 },
};
