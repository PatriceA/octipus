/**
 * Plugin-supplied text is put in front of models inside fences such as
 * `<plugin-role …>…</plugin-role>`, `<plugin-prompt …>` and
 * `<plugin-context …>`. The text must not be able to close its fence or
 * open another, nor look as if it did: so every angle-bracket form becomes
 * `‹` / `›` (ASCII, fullwidth, the other Unicode angle brackets and the HTML
 * entities), and the fence tag names themselves are rewritten
 * (`plugin-role` → `plugin_role`), so not even a literal `‹/plugin-role›` in
 * the package's text spells a closing tag.
 */

const OPEN = /[<＜〈〈⟨﹤]|&(?:lt|#0*60|#x0*3c);?/gi;
const CLOSE = /[>＞〉〉⟩﹥]|&(?:gt|#0*62|#x0*3e);?/gi;
const TAG_NAMES = /plugin[-‐‑‒–—－](role|prompt|context)/gi;

/** `text` with every fence look-alike neutralised. */
export function neutraliseFencedText(text: string): string {
  return text.replace(OPEN, '‹').replace(CLOSE, '›').replace(TAG_NAMES, (_m, name: string) => `plugin_${name}`);
}
