/**
 * One-off hints in shared chats ("link your account first", "I'm paused
 * here") go out at most once a day per key, so a busy channel never fills
 * with them. In memory: a restart may repeat a hint once, which is harmless.
 */
const HINT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 5_000;
const sent = new Map<string, number>();

/** Whether to send the hint for `key` now; records it when true. */
export function shouldSendHint(key: string, now = Date.now()): boolean {
  const last = sent.get(key);
  if (last !== undefined && now - last < HINT_INTERVAL_MS) return false;
  sent.delete(key); // re-insert: Map order doubles as LRU order
  sent.set(key, now);
  if (sent.size > MAX_KEYS) sent.delete(sent.keys().next().value as string);
  return true;
}

/** Test seam. */
export function resetHintLimiter(): void {
  sent.clear();
}
