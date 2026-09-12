/**
 * Minimal env for a spawned vendor CLI (C6). Only PATH/HOME/locale/TERM, the
 * CLI's own auth var, and per-tool overrides — NOT the server's full env
 * (DB creds, every API key, internal secrets).
 *
 * Shared by the CLI agent worker and the one-shot `CLIProvider.complete()`
 * path; the latter used to spawn with the whole `process.env`.
 */
import type { CLIToolConfig } from '@/models/providers/cli-provider';

export function buildChildEnv(tool: CLIToolConfig, toolEnv?: Record<string, string>, inheritApiKeys = false): Record<string, string> {
  const base: Record<string, string> = {};
  const pass = (k: string) => { const v = process.env[k]; if (v != null) base[k] = v; };
  // Core shell/runtime env every CLI needs to find its binary + config dir.
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM', 'TZ', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'CODEX_HOME']) pass(k);
  // Windows equivalents.
  for (const k of ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP']) pass(k);
  // Locale (LC_ALL, LC_CTYPE, …).
  for (const k of Object.keys(process.env)) if (k.startsWith('LC_')) pass(k);
  // The CLI's own auth vars — scoped per provider so codex doesn't see the
  // Anthropic key, etc.
  const authByProvider: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    mistral: ['MISTRAL_API_KEY'],
  };
  if (inheritApiKeys) for (const k of authByProvider[tool.modelProvider] || []) pass(k);
  if (tool.modelProvider === 'anthropic') pass('CLAUDE_CODE_OAUTH_TOKEN');
  // Per-tool overrides (e.g. vibe's ephemeral VIBE_HOME).
  Object.assign(base, toolEnv || {});
  // Never let the child think it's running inside Claude Code itself.
  delete base.CLAUDECODE;
  return base;
}
