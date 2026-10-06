import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./audit-all.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

for (const failure of ['', 'octipus', 'web', 'mcp-server']) {
  test(`audits every package and propagates ${failure || 'no'} failure`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'octipus-audit-'));
    try {
      const cli = join(temp, 'npm.cjs');
      const log = join(temp, 'calls.jsonl');
      writeFileSync(cli, `
        const { appendFileSync } = require('node:fs');
        const { basename } = require('node:path');
        appendFileSync(process.env.AUDIT_TEST_LOG, JSON.stringify({
          cwd: process.cwd(), args: process.argv.slice(2)
        }) + '\\n');
        process.exit(basename(process.cwd()) === process.env.AUDIT_TEST_FAILURE ? 1 : 0);
      `);
      const result = spawnSync(process.execPath, [script], {
        cwd: temp,
        env: { ...process.env, npm_execpath: cli, AUDIT_TEST_LOG: log, AUDIT_TEST_FAILURE: failure },
        encoding: 'utf8',
      });
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(calls, ['.', 'web', 'mcp-server'].map(folder => ({
        cwd: join(root, folder),
        args: ['audit', '--include=dev', '--audit-level=low'],
      })));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
