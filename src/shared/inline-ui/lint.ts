/**
 * Server-side checks of an authored interactive answer. This is a lint, not
 * the security boundary: the frame CSP and the content runtime's DOM
 * sanitizer (frames.ts) enforce the same rules on the parsed document, so a
 * pattern this misses gains nothing. Its job is telling the model, in the same
 * turn, what will not work so it can fix it (spec §4.3, G3).
 *
 * - `fatal`: the block cannot be shown (cut off, empty, too large, bad script).
 * - `repairable`: the block can be shown, but these parts will be removed or
 *   will not run; worth one repair round.
 */
import type { InlineUiParts } from './fence';
import { INLINE_UI_LIMITS } from './limits';

export interface InlineUiIssue {
  code: string;
  severity: 'fatal' | 'repairable';
  message: string;
}

const REFUSED_ELEMENTS = ['meta', 'link', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'form', 'noscript', 'template', 'slot'];

const CHECKS: Array<{ code: string; field: 'html' | 'css'; re: RegExp; message: string }> = [
  { code: 'refused-element', field: 'html', re: new RegExp(`<(${REFUSED_ELEMENTS.join('|')})\\b`, 'i'), message: 'elements meta, link, base, iframe, frame, object, embed, portal, form, noscript, template and slot are removed — use buttons with addEventListener instead of forms' },
  { code: 'inline-handler', field: 'html', re: /<[^>]+\son[a-z]+\s*=/i, message: 'inline event attributes (onclick=…) do not run — attach listeners with addEventListener in the <script>' },
  { code: 'javascript-url', field: 'html', re: /\b(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i, message: 'javascript: URLs do not run' },
  { code: 'remote-resource', field: 'html', re: /\b(?:src|srcset|poster|background|xlink:href)\s*=\s*["']?\s*(?:https?:|\/\/)/i, message: 'remote images, media and scripts are blocked — there is no network; draw with SVG/canvas or use data: URLs' },
  { code: 'smil-href', field: 'html', re: /<set\b|<animate\w*\b[^>]*attributeName\s*=\s*["']?\s*(?:xlink:href|href|src)\b/i, message: 'SVG <set> and animations of href/src are removed' },
  { code: 'credential-input', field: 'html', re: /\btype\s*=\s*["']?\s*(?:password|file)\b|\bautocomplete\s*=\s*["']?[^"'>]*password/i, message: 'password and file inputs are removed — never ask for credentials or files in an interactive answer' },
  { code: 'focus-steal', field: 'html', re: /\bautofocus\b/i, message: 'autofocus is removed' },
  { code: 'remote-css', field: 'css', re: /@import|(?:url|image-set)\(\s*["']?\s*(?:https?:|\/\/)/i, message: 'remote stylesheets, fonts and images are blocked — there is no network' },
  { code: 'text-security', field: 'css', re: /text-security/i, message: 'text-security is removed' },
];

export function lintInlineUi(parts: InlineUiParts, opts: { closed: boolean }): InlineUiIssue[] {
  const issues: InlineUiIssue[] = [];
  const L = INLINE_UI_LIMITS;
  if (!opts.closed || parts.issues.includes('unclosed-style') || parts.issues.includes('unclosed-script')) {
    issues.push({ code: 'cut-off', severity: 'fatal', message: 'the block was cut off before its closing fence — make it smaller (aim for under 12 KB)' });
  }
  if (!parts.html.trim()) issues.push({ code: 'empty', severity: 'fatal', message: 'the block has no visible markup' });
  if (parts.html.length > L.htmlChars) issues.push({ code: 'too-large', severity: 'fatal', message: `markup is ${parts.html.length} characters; the limit is ${L.htmlChars}` });
  if (parts.css.length > L.cssChars) issues.push({ code: 'too-large', severity: 'fatal', message: `styles are ${parts.css.length} characters; the limit is ${L.cssChars}` });
  if (parts.js.length > L.jsChars) issues.push({ code: 'too-large', severity: 'fatal', message: `script is ${parts.js.length} characters; the limit is ${L.jsChars}` });
  const total = parts.html.length + parts.css.length + parts.js.length;
  if (total > L.totalChars) issues.push({ code: 'too-large', severity: 'fatal', message: `the block is ${total} characters; the limit is ${L.totalChars}` });
  if (parts.issues.includes('script-src')) issues.push({ code: 'remote-resource', severity: 'repairable', message: '<script src> is removed — there is no network; put the code in an inline <script>' });
  if (parts.issues.includes('script-type')) issues.push({ code: 'script-type', severity: 'repairable', message: 'only plain inline <script> elements run' });
  for (const check of CHECKS) {
    if (check.re.test(check.field === 'html' ? parts.html : parts.css) && !issues.some((i) => i.code === check.code)) {
      issues.push({ code: check.code, severity: 'repairable', message: check.message });
    }
  }
  return issues;
}

/** One line per issue, for the repair message and the notice the user sees. */
export function describeInlineUiIssues(issues: InlineUiIssue[]): string {
  return issues.map((i) => `- ${i.message}`).join('\n');
}
