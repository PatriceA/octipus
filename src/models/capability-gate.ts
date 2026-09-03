/**
 * Capability gate — verify a model can actually do tool-calling and JSON output
 * before (or after) it's bound to topics. Small local models routinely report
 * `supportsTools: true` yet emit malformed tool-call JSON, and ignore JSON-mode
 * requests. The static check is a cheap, network-free heuristic used to warn
 * at register time; the live check runs the real conformance subset on demand.
 */
import { getConfig } from '@/config';
import { deriveParamCount } from '@/core/agent/prompt-tier';
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
export function staticCapabilityWarnings(
  model: {
    provider: string;
    modelId: string;
    metadata?: ModelConfigEntry['metadata'];
  },
  /** Same threshold the worker/root agent small tier uses, so the warning and
   *  the actual behavior agree. Defaults to 10B when no config is threaded in. */
  routerMaxParams = 10_000_000_000,
): string[] {
  const warnings: string[] = [];
  const isLocal = model.provider === 'ollama';
  const params = deriveParamCount(model.modelId, model.metadata ?? undefined);

  if (isLocal && params !== undefined && params < routerMaxParams) {
    warnings.push(
      `Small local model (~${Math.round(params / 1e9)}B): tool-calling and JSON output are often unreliable below ~10B. ` +
        'Run a capability check (POST /api/models/:name/check-capabilities) before relying on it for agent work.',
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

  // Tool-calling is the thing this gate exists to verify ("can it drive the
  // swarm"). Only claim `capable` once tool-calling actually PASSED — a skipped
  // tool-calling test (capability flags say N/A, or no live model) proves
  // nothing, so it's `unknown`, not `capable`.
  let verdict: CapabilityVerdict['verdict'];
  if (toolCalling.status === 'failed' || structuredOutput.status === 'failed') {
    verdict = 'incapable';
  } else if (toolCalling.status === 'passed') {
    verdict = 'capable';
  } else {
    verdict = 'unknown';
  }

  return {
    model: model.modelId,
    provider: model.provider,
    verdict,
    toolCalling,
    structuredOutput,
    warnings: staticCapabilityWarnings(model, getConfig().agent.smallModelMaxParams),
  };
}
