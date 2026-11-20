/**
 * The few lines a phone call says that no model wrote — the greeting, the
 * re-prompt after silence, the apology when a turn fails — in the install's
 * language (`voice.language`), and that language as the locale a carrier's
 * recogniser and voice expect.
 */

export type PhonePhrase = 'greeting' | 'trouble' | 'didNotCatch' | 'stillThere' | 'listening' | 'askPermission' | 'askApproval';

/** `{tool}` / `{question}` are filled in by the caller of `phonePhrase`. */
const PHRASES: Record<string, Record<PhonePhrase, string>> = {
  en: {
    greeting: 'Hello, how can I help you?',
    trouble: 'I had trouble processing that. Could you repeat?',
    didNotCatch: "I didn't catch that.",
    stillThere: "I didn't catch that. Are you still there?",
    listening: "Go ahead, I'm listening.",
    askPermission: 'I need your permission to use {tool}. Say yes to allow it, or no.',
    askApproval: '{question} Say yes or no.',
  },
  de: {
    greeting: 'Hallo, wie kann ich Ihnen helfen?',
    trouble: 'Das konnte ich gerade nicht verarbeiten. Können Sie es bitte wiederholen?',
    didNotCatch: 'Das habe ich nicht verstanden.',
    stillThere: 'Das habe ich nicht verstanden. Sind Sie noch da?',
    listening: 'Bitte sprechen Sie, ich höre zu.',
    askPermission: 'Ich brauche Ihre Erlaubnis für {tool}. Sagen Sie ja, um es zu erlauben, oder nein.',
    askApproval: '{question} Sagen Sie ja oder nein.',
  },
};

/** `de-DE`, `DE`, `de_AT` → `de`. */
function baseLanguage(language: string | null | undefined): string {
  return (language || 'en').trim().toLowerCase().split(/[-_]/)[0] || 'en';
}

/** A fixed phone line in `language`; English for a language without its own lines. */
export function phonePhrase(key: PhonePhrase, language: string | null | undefined): string {
  return (PHRASES[baseLanguage(language)] ?? PHRASES.en)[key];
}

/** Carriers want a region with the language; a bare `en` is not a locale to them. */
const DEFAULT_REGION: Record<string, string> = {
  en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL',
  ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', pl: 'pl-PL', sv: 'sv-SE', da: 'da-DK', ru: 'ru-RU', tr: 'tr-TR',
};

/** `voice.language` as a carrier locale: `de` → `de-DE`; a value that already has a region is kept. */
export function telephonyLocale(language: string | null | undefined): string {
  const value = (language || 'en').trim().replace('_', '-');
  const [lang, region] = value.split('-');
  if (region) return `${lang.toLowerCase()}-${region.toUpperCase()}`;
  return DEFAULT_REGION[lang.toLowerCase()] ?? 'en-US';
}
