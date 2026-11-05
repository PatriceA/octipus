/**
 * Request rules Octipus applies to every Claude model — by family, never by
 * version.
 *
 * - No forced tool call. `tool_choice: any` / `tool` is a 400 on the current
 *   models (Fable 5.1, Opus 5.5, Sonnet 5.5) and on older ones whenever
 *   thinking is on. A forced call is only ever an escalation here (the agent
 *   loop's one-shot `required`), so it becomes `auto`.
 * - No sampling parameters. `temperature` / `top_p` / `top_k` are a 400 on
 *   Opus 4.7 and later, a 400 at any non-default value on Sonnet 5.5 and
 *   Haiku 5.5, and a 400 on every model under API version 2026-10-21.
 *
 * Both used to be version lists, and a version list fails open: the next model
 * is broken until someone adds it (Haiku 5.5 was, for sampling). Each release
 * has tightened these rules, never loosened them, so they hold for all.
 */

/** The tool choice a Claude request carries: `required` is never sent. */
export function claudeToolChoice(choice: 'auto' | 'required' | 'none' | undefined): 'auto' | 'none' {
  return choice === 'none' ? 'none' : 'auto';
}

const SAMPLING = ['temperature', 'top_p', 'top_k'] as const;

/** Remove the sampling parameters from a Claude request body (any wire shape). */
export function dropClaudeSampling(body: Record<string, unknown>): void {
  for (const key of SAMPLING) delete body[key];
}
