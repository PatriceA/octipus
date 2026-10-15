/**
 * The page an OAuth popup lands on (sign-in providers and connectors): it
 * tells the window that opened it how the connect went, then closes.
 *
 * Its one inline script runs under a per-response nonce. Before, these pages
 * asked for `'unsafe-inline'` (connectors) or nothing (providers), and the
 * global `script-src 'self'` replaced both, so the opener never heard back
 * and the popup stayed open. What the request carried — the provider's
 * `error_description`, an id from the path — reaches the script only as
 * script-safe JSON and the markup only escaped: with `'unsafe-inline'`, a
 * `</script>` in `?error=` used to run as the app's origin.
 */
import { randomBytes } from 'node:crypto';
import { escapeHtml, jsonForScript } from '@/shared/html';

export interface PopupCallbackInput {
  ok: boolean;
  heading: string;
  detail: string;
  /** Posted to the opener, at this page's own origin only. */
  message: Record<string, unknown>;
  /** Close the popup after this long; omit to leave an error on screen. */
  closeAfterMs?: number;
}

const STYLE = `body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{text-align:center;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);max-width:400px}
.icon{font-size:3rem;margin-bottom:1rem}h2{margin:0 0 .5rem;color:#111827}
p{margin:0;word-break:break-word;color:#6b7280}.error p{color:#dc2626}`;

export function popupCallbackPage(input: PopupCallbackInput): { html: string; csp: string } {
  const nonce = randomBytes(16).toString('base64');
  const close = input.closeAfterMs === undefined ? '' : `setTimeout(function () { window.close(); }, ${Math.max(0, Math.floor(input.closeAfterMs))});`;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(input.heading)}</title><style>${STYLE}</style></head>
<body><div class="card${input.ok ? '' : ' error'}">
<div class="icon">${input.ok ? '&#10004;' : '&#10008;'}</div>
<h2>${escapeHtml(input.heading)}</h2>
<p>${escapeHtml(input.detail)}</p>
</div>
<script nonce="${nonce}">
try { if (window.opener) window.opener.postMessage(${jsonForScript(input.message)}, window.location.origin); } catch (_) {}
${close}
</script>
</body></html>`;
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ');
  return { html, csp };
}

/** Respond with the page: its own policy, which the global security headers keep. */
export function sendPopupCallback(set: { headers: Record<string, string> }, input: PopupCallbackInput): string {
  const page = popupCallbackPage(input);
  set.headers['content-type'] = 'text/html; charset=utf-8';
  set.headers['Content-Security-Policy'] = page.csp;
  return page.html;
}
