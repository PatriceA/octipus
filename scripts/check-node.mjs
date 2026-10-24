#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
/**
 * A fixed release of a supported line: 24.22.1 / 26.12.1, the October 2026
 * Node security release (Brotli RCE, TLS hostname checks, dns.resolve). 24.19
 * already had the crypto APIs and the module-loader fix. Node 25 is
 * end-of-life and gets no fixes. Keep scripts/install.sh and install.ps1 in step.
 */
const FLOOR = { 24: [22, 1], 26: [12, 1] };
export function supportedNode(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major > 26) return true;
  const floor = FLOOR[major];
  return !!floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !supportedNode(process.versions.node)) {
  console.error(`Octipus requires Node.js >=24.22.1 (or >=26.12.1); found ${process.versions.node}. Install a current Node 24 or 26 (with npm), reopen your terminal, and retry. Earlier versions miss the October 2026 Node security fixes.`);
  process.exitCode = 1;
}
