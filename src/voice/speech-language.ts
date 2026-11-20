/**
 * The language a speech engine is told (`voice.language`). The setting may
 * hold a locale (`en-US`, `de_DE`) — a telephony carrier wants one — but
 * Whisper, OpenAI, Mistral and the OpenAI-compatible servers take an ISO 639-1
 * code and refuse anything else, so every engine sends it through here.
 */

/** `en-US` / `de_DE` → `en` / `de`; empty or `auto` → undefined (let the engine detect it). */
export function speechLanguage(language: string | null | undefined): string | undefined {
  const base = (language ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!base || base === 'auto') return undefined;
  return /^[a-z]{2,3}$/.test(base) ? base : undefined;
}
