/**
 * Sanitize an assistant reply for text-to-speech.
 *
 * The orchestrator appends a `_Sources: …_` footer to replies (appendSources)
 * and replies contain markdown — both get read aloud verbatim otherwise ("bot
 * says 'Sources: recent 10 msgs'"). Strip the footer, code, and markup so the
 * voice speaks only the prose.
 */
export function stripForSpeech(text: string): string {
  return text
    .replace(/\n+_Sources:[^\n]*_/gi, '') // orchestrator sources footer
    .replace(/```[\s\S]*?```/g, ' ') // don't read code blocks aloud
    .replace(/`([^`]+)`/g, '$1') // inline code → its text
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1') // links/images → label
    .replace(/^[#>\s-]+/gm, '') // heading/quote/list markers at line start
    .replace(/[*_~|]/g, '') // emphasis / table pipes
    .replace(/\s{2,}/g, ' ')
    .trim();
}
