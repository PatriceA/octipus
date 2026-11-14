import { AGY_MANAGED_AGENT } from './agy-cli-runtime';
import type { CompletionResult } from '@/models/litellm-client';

/** AGY input already includes cache hits; thinking is a subset of output. */
export function agyUsage(raw: unknown): CompletionResult['usage'] {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  const inputTokens = count(value.input_tokens);
  const outputTokens = count(value.output_tokens);
  const cacheReadTokens = Math.min(inputTokens, count(value.cache_read_tokens));
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    cacheReadTokens, available: [value.input_tokens, value.output_tokens].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) };
}

/** Tool-less replies must prove their managed startup and contain no actions. */
export function verifyAgyToollessOutput(stdout: string, cwd: string): void {
  let initialized = false;
  let finished = false;
  for (const line of stdout.split(/\r?\n/).filter(line => line.trim())) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error('Antigravity tool-less reply contains invalid protocol output'); }
    if (!event || typeof event !== 'object') throw new Error('Antigravity tool-less reply contains invalid protocol output');
    if (event.event === 'result') {
      const result = event.result as Record<string, unknown> | undefined;
      if (result?.status !== 'SUCCESS') throw new Error(`Antigravity failed: ${typeof result?.error === 'string' ? result.error : 'unknown error'}`);
      if (!initialized || finished) throw new Error('Antigravity tool-less completion has no verified startup or has repeated results');
      finished = true;
      continue;
    }
    if (finished) throw new Error('Antigravity emitted activity after completion');
    if (event.event === 'init') {
      const init = event.init as Record<string, unknown> | undefined;
      if (initialized || init?.agent !== AGY_MANAGED_AGENT || init.cwd !== cwd) throw new Error('Antigravity tool-less completion did not load the isolated agent');
      initialized = true;
      continue;
    }
    if (!initialized) throw new Error('Antigravity tool-less completion has no verified startup');
    if (event.event !== 'step_update') throw new Error('Antigravity emitted an unknown tool-less protocol event');
    const step = event.step_update as Record<string, unknown> | undefined;
    if (step?.step_type === 'tool' || step?.subagent_info) throw new Error('Antigravity attempted an action in a tool-less completion');
  }
  if (!finished) throw new Error('Antigravity tool-less completion has no terminal result');
}
