/**
 * Per-session model override (Phase 6).
 *
 * The user can switch the root agent's model mid-session via the
 * `/model <id>` slash command. The override lives in memory only —
 * sessions reset to the configured default on restart. Persistence
 * to `session_overrides` (or similar) is a future expansion; the
 * in-memory shape keeps the change small and reviewable.
 *
 * Keyed by (sessionId, userId) and holding the registry row NAME (coworking
 * spec §8.2): in a shared session one member's `/model` choice — possibly
 * their own personal model — never becomes another member's model, and the
 * name pins the row even when two rows share a modelId.
 *
 * Workers (specialist roles) still resolve via topic → model registry.
 * Only the root agent honors this override.
 */

const overrides = new Map<string, string>();

function key(sessionId: string, userId: string): string {
  return `${sessionId}\u0000${userId}`;
}

export function setSessionModel(sessionId: string, userId: string, modelName: string): void {
  if (!sessionId || !userId) return;
  overrides.set(key(sessionId, userId), modelName);
}

export function getSessionModel(sessionId: string, userId: string): string | undefined {
  return overrides.get(key(sessionId, userId));
}

export function clearSessionModel(sessionId: string, userId: string): boolean {
  return overrides.delete(key(sessionId, userId));
}

/** Test helper — wipe the entire map. Production never needs this. */
export function _resetSessionModelOverridesForTesting(): void {
  overrides.clear();
}
