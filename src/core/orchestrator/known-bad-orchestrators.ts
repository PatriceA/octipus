/**
 * Local models known to produce malformed tool-call output (unbalanced
 * JSON, XML-formatted function tags, interleaved think/tool markers)
 * when used as an orchestrator. Octipus already classifies the resulting
 * Ollama 400 ("Value looks like object, but can't find closing '}' symbol")
 * as a retryable tool-call error, but Qwen3 builds keep failing the same
 * way across retries — so retrying just burns time before the agent
 * gives up. `selectForOrchestration()` consults this list and auto-swaps
 * to a working alternative when one is configured.
 *
 * Add a pattern here whenever a model is reproducibly unable to handle
 * the orchestrator's `spawn_child` / `create_pipeline` tool surface.
 *
 * Evidence (2026-05-12 QA run):
 *   ❌ qwen3:8b              — fails iter 2+, retries exhaust at iter 5
 *   ❌ qwen3.6:27b           — same signature, same failure
 *   ❌ qwen3.6:35b-a3b-q4_K_M — same family, quantized, still fails
 *
 * Known-good local baseline (also from the 2026-05-12 run, tested
 * end-to-end against the same orchestrator prompt):
 *   ✅ glm-4.7-flash:latest   — recommended local orchestrator
 *   ✅ qwen2.5:32b           — proven tool-calling track record
 *
 * Cloud-hosted Qwen3 (via OpenRouter/DeepInfra) is unaffected and stays
 * off this list — the issue is the Ollama Go-side parser combined with
 * Qwen3's tool-call output shape, not the model family in the abstract.
 * `qwen3-vl:*` is a distinct family (dash separator) and not flagged.
 *
 * See docs/TROUBLESHOOTING.md → "Orchestrator Fails with ..." for the
 * user-facing recommendation matrix.
 */

interface BadOrchestratorRule {
  /** Regex tested against the canonical model id (lowercase). */
  pattern: RegExp;
  /** Short reason surfaced in the warning. */
  reason: string;
}

const KNOWN_BAD: BadOrchestratorRule[] = [
  {
    // Whole Qwen3 family in Ollama (qwen3:8b, qwen3:14b, qwen3.5, qwen3.6, …).
    // Observed across the 2026-05-12 QA run: qwen3:8b, qwen3.6:27b,
    // qwen3.6:35b-a3b-q4_K_M all fail iteration 2+ with the Ollama Go-side
    // parser rejection "Value looks like object, but can't find closing
    // '}' symbol". Issue is structural — the model's tool-call output
    // doesn't survive Ollama's strict parser — so retries don't help.
    //
    // `qwen3-vl:*` (vision-language variant, dash-separated family name)
    // is a distinct family and not on this list.
    pattern: /^qwen3(\.\d+)?:/i,
    reason:
      'Qwen3 local builds reliably emit malformed tool-call JSON via Ollama ' +
      '(unbalanced braces). Pick a larger or better-instruction-tuned model ' +
      '(qwen2.5:32b, a cloud model, or anything with a proven tool-calling ' +
      'track record).',
  },
];

export interface OrchestratorCapabilityWarning {
  modelId: string;
  reason: string;
}

/**
 * Return a warning when the given model id is known to be unreliable as
 * an orchestrator, or null otherwise. The caller decides whether to log,
 * surface to the UI, or block.
 */
export function checkOrchestratorCapability(modelId: string): OrchestratorCapabilityWarning | null {
  for (const rule of KNOWN_BAD) {
    if (rule.pattern.test(modelId)) {
      return { modelId, reason: rule.reason };
    }
  }
  return null;
}
