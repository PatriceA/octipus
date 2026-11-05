// Detached launcher: deliberately owns no database connection (embedded DB may
// only be opened by the backend). Communicates completion through an atomic file.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const file = process.argv[2];
const intent = JSON.parse(readFileSync(file, 'utf8'));
const finish = result => {
  writeFileSync(`${file}.tmp`, JSON.stringify({ id: intent.id, ...result }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};
try {
  const result = spawnSync(process.execPath, [join(intent.root, 'bin/octi.mjs'), 'restart', 'web'], {
    cwd: intent.root, env: { ...process.env, OCTI_NO_BROWSER: '1' }, stdio: 'ignore', timeout: 300000,
  });
  finish({ status: result.status === 0 ? 'restarted' : 'failed', result: result.status === 0
    ? 'External launcher completed restart. Verify the running version and affected runtime before resolving the incident.'
    : 'External launcher failed or timed out. Inspect service state; do not repeat activation blindly.' });
} catch { finish({ status: 'failed', result: 'External launcher could not complete; inspect service state before another activation.' }); }
