#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
export function supportedNode(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 19);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !supportedNode(process.versions.node)) {
  console.error(`Octipus requires Node.js >=24.19.0; found ${process.versions.node}. Install Node 24.19+ (with npm), reopen your terminal, and retry. Earlier versions lack required crypto APIs or have a module-loader bug.`);
  process.exitCode = 1;
}
