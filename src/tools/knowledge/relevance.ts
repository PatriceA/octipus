import { decide, type DecisionSite } from '@/models/decision';

const RELEVANCE_SITE: DecisionSite = { id: 'knowledge.relevance', sensitivity: 'personal', minConfidence: 0 };
const DROP_BELOW = 0.2;

/** Drop only confidently irrelevant passages; unavailable/uncertain decisions preserve hits. */
export async function filterRelevance<T extends { abstract?: string | null; content: string }>(query: string, results: T[]): Promise<T[]> {
  if (results.length < 2) return results;
  const passages = Object.fromEntries(results.map((r, i) => [String(i + 1), (r.abstract || r.content).slice(0, 1500)]));
  const questions = Object.fromEntries(results.map((_, i) => [`p${i + 1}`, {
    type: 'noul' as const,
    instructions: `Passage ${i + 1} contains information that helps answer the query.`,
  }]));
  const answers = await decide(RELEVANCE_SITE, { query, passages }, questions);
  if (!answers) return results;
  return results.filter((_, i) => {
    const answer = answers[`p${i + 1}`];
    return answer?.type !== 'noul' || answer.p >= DROP_BELOW;
  });
}
