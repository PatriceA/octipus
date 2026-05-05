/**
 * Terminal glyph table.
 *
 * Many Linux terminal fonts ship without an emoji subset, in which case
 * `📁` renders as a tofu box (`U+1F4C1`). Default to ASCII unless we see
 * a signal that the host terminal supports emoji (`TERM_PROGRAM` set to
 * a known emoji-capable terminal) or the user opts in via env.
 *
 *   OCTIPUS_TUI_ICONS=ascii   force ASCII fallback
 *   OCTIPUS_TUI_ICONS=emoji   force emoji on
 */
export interface Glyphs {
  dir: string;
  file: string;
  project: string;
}

const EMOJI: Glyphs = { dir: '📁 ', file: '📄 ', project: '📁 ' };
const ASCII: Glyphs = { dir: '[+] ', file: '    ', project: '· ' };

const EMOJI_CAPABLE = ['kitty', 'wezterm', 'iterm.app', 'vscode', 'apple_terminal', 'ghostty'];

let cached: Glyphs | null = null;

export function getGlyphs(): Glyphs {
  if (cached) return cached;
  const override = process.env.OCTIPUS_TUI_ICONS;
  if (override === 'ascii') return (cached = ASCII);
  if (override === 'emoji') return (cached = EMOJI);
  const term = (process.env.TERM_PROGRAM ?? '').toLowerCase();
  cached = EMOJI_CAPABLE.some((p) => term.includes(p)) ? EMOJI : ASCII;
  return cached;
}

/** Test aid: drop the cached selection so env overrides can be re-read. */
export function resetGlyphs(): void { cached = null; }
