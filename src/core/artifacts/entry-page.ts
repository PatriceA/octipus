import { createHash } from 'node:crypto';
import { escapeHtml } from '@/shared/html';

/** Establish a same-site document before retrying a Strict-cookie artifact link. */
export function artifactEntryPage(signInUrl: string): { html: string; csp: string } {
  // Never embed a token or artifact metadata. Unknown and inaccessible slugs
  // have exactly the same entry page. The retry still runs normal authorization.
  const script = `fetch(location.href, {credentials:'same-origin', headers:{'X-Octipus-Artifact-Entry':'1'}, cache:'no-store'})
.then(function(r){if(r.ok) location.replace(location.href); else document.getElementById('status').textContent='Sign in to Octipus, or use a valid share link, to open this artifact.';})
.catch(function(){document.getElementById('status').textContent='Could not reach Octipus. Try opening the artifact again.';});`;
  const hash = createHash('sha256').update(script).digest('base64');
  return {
    csp: `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open artifact · Octipus</title>
<style>body{font:16px/1.6 system-ui;max-width:36rem;margin:15vh auto;padding:24px}a{margin-right:16px}</style></head>
<body><h1>Open artifact</h1><p id="status">Checking your Octipus session…</p><a href="${escapeHtml(signInUrl)}">Sign in to Octipus</a><a href="">Try again</a><script>${script}</script></body></html>`,
  };
}
