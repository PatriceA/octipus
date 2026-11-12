/**
 * Text that comes from a registry, a keys file or a package, checked before
 * it is shown anywhere (docs/PLUGIN-PACKAGES.md#index-v2): no control
 * characters, and none of the bidirectional, zero-width or otherwise
 * invisible characters that can make a short text read as something else, or
 * a terminal do something when it is printed.
 *
 * Pure: imported by the offline CLI as well as the host.
 */
import { z } from 'zod';

/** C0 controls other than tab, newline and carriage return, DEL and C1 controls. */
export const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** Any control character at all (single-line fields). */
export const ANY_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
/**
 * Bidirectional marks, embeddings, overrides and isolates; zero-width and
 * invisible characters (the soft hyphen, the Mongolian vowel separator, the
 * word joiner and invisible operators, the Hangul fillers, the byte order
 * mark); and the tag characters, which render as nothing.
 */
export const INVISIBLE_RE = /[­؜ᅟ᠎​-‏‪-‮⁠-⁤⁦-⁩ㅤ﻿]|\u{E0000}|[\u{E0001}-\u{E007F}]/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A single-line text field. */
export const line = (max: number) => z.string().max(max)
  .refine((s) => !ANY_CONTROL_RE.test(s), 'no control characters')
  .refine((s) => !INVISIBLE_RE.test(s), 'no bidirectional or invisible formatting characters');
/** A Markdown text (README, CHANGELOG): tab and newlines allowed, other controls not. */
export const markdown = (max: number) => z.string().max(max).refine((s) => !CONTROL_RE.test(s), 'no control characters');
/** An ISO date-time with a zone. */
export const isoTime = z.string().max(40).regex(ISO_RE, 'an ISO date-time with a zone').refine((s) => !Number.isNaN(Date.parse(s)), 'not a real time');

const STRIP_ALL_RE = new RegExp(`${ANY_CONTROL_RE.source}|${INVISIBLE_RE.source}`, 'gu');

/**
 * `text` with every control, bidirectional and invisible character removed:
 * for text echoed from hostile input where refusing is not the answer (a v1
 * description, a name in a problem label, a schema path).
 */
export function safeText(text: string, max = 500): string {
  return text.replace(STRIP_ALL_RE, '').slice(0, max);
}
