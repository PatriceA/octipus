import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { supportedNode } from './check-node.mjs';

test('Node floor rejects the old runtime and the known-broken 24.9 loader', () => {
  for (const version of ['18.20.0', '22.20.0', '24.8.0', '24.9.0', '24.18.9']) assert.equal(supportedNode(version), false);
  for (const version of ['24.19.0', '24.20.0', '26.2.0']) assert.equal(supportedNode(version), true);
});
for (const mode of ['old-node', 'success', 'build-failure', 'audit-failure']) {
  test(`installer: ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'octipus-install-test-'));
    try {
      const tools = join(dir, 'tools'); const app = join(dir, 'app'); const log = join(dir, 'calls');
      mkdirSync(tools); mkdirSync(join(app, '.git'), { recursive: true });
      for (const name of ['node', 'git', 'npm']) {
        writeFileSync(join(tools, name), `#!/bin/bash
printf '%s %s\\n' '${name}' "$*" >> "$CALL_LOG"
${name === 'node' ? `if [ "$1" = -e ] && [ "$TEST_MODE" = old-node ]; then exit 1; fi\necho 26.2.0` : ''}
${name === 'npm' ? `if [ "$*" = 'run build' ] && [ "$TEST_MODE" = build-failure ]; then exit 1; fi
if [ "$*" = 'run audit:all' ] && [ "$TEST_MODE" = audit-failure ]; then exit 1; fi
if [ "$*" = 'run build:cli' ]; then
mkdir -p dist
printf '#!/bin/bash\\nprintf "cli %%s\\\\n" "$*" >> "$CALL_LOG"\\n' > dist/octi
chmod +x dist/octi
fi` : ''}
`, { mode: 0o755 });
      }
      const result = spawnSync('bash', [resolve('scripts/install.sh'), '--non-interactive'], {
        env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, OCTIPUS_INSTALL_DIR: app, OCTIPUS_BIN_DIR: join(dir, 'bin'), CALL_LOG: log, TEST_MODE: mode }, encoding: 'utf8',
      });
      const calls = readFileSync(log, 'utf8');
      if (mode === 'old-node') { assert.notEqual(result.status, 0); assert.doesNotMatch(calls, /npm /); }
      else if (mode === 'build-failure') { assert.notEqual(result.status, 0); assert.doesNotMatch(calls, /cli setup/); }
      else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(calls, /npm --prefix mcp-server ci --include=dev/);
        assert.match(calls, /npm run audit:all/);
        assert.match(calls, /cli setup --non-interactive/);
        if (mode === 'audit-failure') assert.match(result.stdout, /audit needs attention/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
