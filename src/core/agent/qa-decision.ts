import { decide, type DecisionSite } from '@/models/decision';
const QA_SITE: DecisionSite = { id: 'pipeline.qa-verdict', sensitivity: 'secret', minConfidence: 0.8 };

/** A confident blocking finding can reject a pass; approval still requires the audit's evidence. */
export async function applyDecisionQaVerdict<T extends { passed: boolean; issues: string[] }>(output: string, parsed: T): Promise<T> {
  if (!parsed.passed) return parsed;
  const answers = await decide(QA_SITE, { report: output.slice(-12_000) }, {
    passed: {
      type: 'noul',
      instructions: 'The audit report concludes that the audited work passes: no blocking issue remains.',
      criteria: { true: 'the report approves the work, at most with minor notes', false: 'the report names blocking issues, fails the work, or asks for changes' },
    },
  });
  const answer = answers?.passed;
  if (answer?.type !== 'noul' || answer.p >= 0.5) return parsed;
  return { ...parsed, passed: false, issues: [...parsed.issues, 'The decision model found blocking issues in the audit report despite its passing verdict.'] };
}
