/**
 * Per-session model override (Phase 6).
 *
 * The user can switch the root agent's model mid-session via the
 * `/model <id>` slash command. The override lives in memory only —
 * sessions reset to the configured default on restart. Persistence
 * to `session_overrides` (or similar) is a future expansion; the
 * in-memory shape keeps the change small and reviewable.
 *
 * Workers (specialist roles) still resolve via topic → model registry.
 * Only the root agent honors this override.
 */

const overrides = new Map<string, string>();

export function setSessionModel(sessionId: string, modelId: string): void {
  if (!sessionId) return;
  overrides.set(sessionId, modelId);
}

export function getSessionModel(sessionId: string): string | undefined {
  return overrides.get(sessionId);
}

export function clearSessionModel(sessionId: string): boolean {
  return overrides.delete(sessionId);
}

/** Test helper — wipe the entire map. Production never needs this. */
export function _resetSessionModelOverridesForTesting(): void {
  overrides.clear();
}
