import { ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import { repairTruncatedJson } from '@/utils/json-repair';
import { modelLogger } from '@/utils/logger';

/**
 * Shared tool-call `arguments` parser used by every provider (G4 + A6).
 *
 * Semantics, in order:
 *   1. Already-an-object payloads pass through (some providers return objects).
 *   2. Empty / whitespace-only string → `{}` (zero-arg tool calls).
 *   3. `JSON.parse` — the happy path.
 *   4. `repairTruncatedJson` — providers truncate long argument strings
 *      mid-stream (DeepSeek flash file-writes being the classic case).
 *   5. ClassifiedError TOOL_CALL_INVALID (RETRY_NOW) — fail loud, retryable.
 */
export function parseToolCallArguments(
  rawArgs: string | Record<string, unknown> | null | undefined,
  toolName: string,
  providerName: string,
): Record<string, unknown> {
  if (rawArgs != null && typeof rawArgs === 'object') return rawArgs;
  if (rawArgs == null || rawArgs.trim() === '') return {};

  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch (parseErr) {
    const repaired = repairTruncatedJson(rawArgs);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired) as Record<string, unknown>;
        modelLogger.warn(
          { toolName, rawLength: rawArgs.length, provider: providerName },
          'Recovered truncated tool-call JSON via repairTruncatedJson',
        );
        return parsed;
      } catch { /* fall through to ClassifiedError */ }
    }
    throw new ClassifiedError({
      reason: FailoverReason.TOOL_CALL_INVALID,
      recovery: RecoveryAction.RETRY_NOW,
      message: `Malformed tool call JSON from ${providerName} for tool "${toolName}": ${(parseErr as Error).message}`,
      providerHint: providerName,
      metadata: { toolName, rawLength: rawArgs.length, raw: rawArgs.slice(0, 300) },
      cause: parseErr,
    });
  }
}
