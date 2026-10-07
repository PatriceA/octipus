import { z } from 'zod';

export const CLI_QUESTION_TOOL = 'cli-native:AskUserQuestion';
export const cliQuestionsSchema = z.object({
  questions: z.array(z.object({
    header: z.string().optional(),
    question: z.string().min(1),
    options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).default([]),
    multiSelect: z.boolean().default(false),
  })).min(1),
});

/** Answers are keyed by the original question text, as required by the CLI. */
export function parseCliAnswers(input: unknown, resolution?: string): Record<string, string> {
  const { questions } = cliQuestionsSchema.parse(input);
  if (!resolution) throw new Error('Answer every question before submitting. Allow alone does not answer a question.');
  const answers = z.record(z.string(), z.string().trim().min(1)).parse(JSON.parse(resolution));
  if (questions.some(q => !Object.hasOwn(answers, q.question))) {
    throw new Error('Answer every question before submitting.');
  }
  return Object.fromEntries(questions.map(q => [q.question, answers[q.question]]));
}
