/**
 * The rate-limit bucket and circuit-breaker key of a CLI model, by model id.
 * Shared by the provider router (`resolveRateLimitKey`) and the swarm's
 * pre-spawn availability check, which must read the same breaker the router
 * trips. Kept dependency-free so the spawner need not load every provider.
 */
export function cliRateLimitKey(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('claude')) return 'cli-claude';
  // Antigravity (agy) reuses the Gemini rate bucket — same Google backend.
  if (lower.includes('gemini') || lower.includes('antigravity') || lower.includes('agy')) return 'cli-gemini';
  if (lower.includes('codex')) return 'cli-codex';
  if (lower.includes('vibe')) return 'cli-vibe';
  if (lower.includes('glm') || lower.includes('zai')) return 'cli-glm';
  if (lower.includes('kimi') || lower.includes('moonshot')) return 'cli-kimi';
  return 'cli-claude'; // default CLI
}
