/**
 * Capability gate — verify a model can actually do tool-calling and JSON output
 * before (or after) it's bound to topics. Small local models routinely report
 * `supportsTools: true` yet emit malformed tool-call JSON (see
 * `known-bad-orchestrators`), and ignore JSON-mode requests. The static check
 * is a cheap, network-free heuristic used to warn at register time; the live
 * check runs the real conformance subset on demand.
 */
import { deriveParamCount } from '@/core/orchestrator/mode-selector';
import type { ModelConfigEntry } from '@/db/schema/models';
import type { LiteLLMClient } from './litellm-client';
import type { ModelProvider } from './providers/interface';

/** The conformance tests that matter for the "can this drive the swarm" gate. */
export const GATE_TESTS = ['tool-calling', 'structured-output'] as const;

export interface CapabilityCheckResult {
  status: 'passed' | 'failed' | 'skipped';
  latencyMs?: number;
  error?: string;
}

export interface CapabilityVerdict {
  model: string;
  provider: string;
  /** capable: both gate tests passed. incapable: at least one failed.
   *  unknown: neither ran (skipped — capability flags say N/A, or no live model). */
  verdict: 'capable' | 'incapable' | 'unknown';
  toolCalling: CapabilityCheckResult;
  structuredOutput: CapabilityCheckResult;
  /** Static, network-free heuristics (small local model, known-unreliable id). */
  warnings: string[];
}

/**
 * Cheap, deterministic warnings derived from the model row alone — no network.
 * Used at register time to flag likely-weak models without blocking the insert.
 */
export function staticCapabilityWarnings(model: {
  provider: string;
  modelId: string;
  metadata?: ModelConfigEntry['metadata'];
}): string[] {
  const warnings: string[] = [];
  const isLocal = model.provider === 'ollama';
  const params = deriveParamCount(model.modelId, model.metadata ?? undefined);

  if (isLocal && params !== undefined && params < 10_000_000_000) {
    warnings.push(
      `Small local model (~${Math.round(params / 1e9)}B): tool-calling and JSON output are often unreliable below ~10B. ` +
        'Run a capability check (POST /api/models/:name/check-capabilities) before relying on it for agent work.',
    );
  }
  // Known-unreliable orchestrators (e.g. qwen3 local builds emitting bad tool JSON).
  if (/^qwen3(\.\d+)?:/i.test(model.modelId)) {
    warnings.push(
      'qwen3 local builds reliably emit malformed tool-call JSON via Ollama — prefer a proven tool-caller (qwen2.5:32b, glm-4.x-flash, or a cloud model).',
    );
  }
  return warnings;
}

function mapResult(
  r: { status: 'passed' | 'failed' | 'skipped'; latencyMs?: number; error?: string } | undefined,
): CapabilityCheckResult {
  if (!r) return { status: 'skipped' };
  return { status: r.status, latencyMs: r.latencyMs, error: r.error };
}

/**
 * Live capability check: run the tool-calling + structured-output conformance
 * subset against one model and return a verdict. Conformance is imported lazily
 * to avoid a module cycle (conformance → litellm-client → model-registry).
 */
export async function checkModelCapabilities(
  client: LiteLLMClient,
  model: ModelConfigEntry,
  providers: Map<string, ModelProvider>,
  options?: { timeout?: number; userId?: string },
): Promise<CapabilityVerdict> {
  const { runConformanceTests } = await import('./testing/conformance');
  const report = await runConformanceTests(client, [model], providers, {
    tests: [...GATE_TESTS],
    timeout: options?.timeout ?? 30_000,
    userId: options?.userId,
  });

  const toolCalling = mapResult(report.results.find((r) => r.test === 'tool-calling'));
  const structuredOutput = mapResult(report.results.find((r) => r.test === 'structured-output'));

  const statuses = [toolCalling.status, structuredOutput.status];
  let verdict: CapabilityVerdict['verdict'];
  if (statuses.includes('failed')) verdict = 'incapable';
  else if (statuses.includes('passed')) verdict = 'capable';
  else verdict = 'unknown';

  return {
    model: model.modelId,
    provider: model.provider,
    verdict,
    toolCalling,
    structuredOutput,
    warnings: staticCapabilityWarnings(model),
  };
}
