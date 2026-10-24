import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { auditFindings } from './audit-exceptions.mjs';

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
        const failing = basename(process.cwd()) === process.env.AUDIT_TEST_FAILURE;
        process.stdout.write(JSON.stringify({ vulnerabilities: failing
          ? { leftpad: { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'test' }], nodes: ['node_modules/leftpad'] } }
          : {} }));
        process.exit(failing ? 1 : 0);
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
        args: ['audit', '--include=dev', '--audit-level=low', '--json'],
      })));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

// The botbuilder shape of GHSA-mrhx-c7xc-m3w5: zod nested under the bot packages, which depend on it.
const zodUnderBotbuilder = (extra = {}) => ({
  vulnerabilities: {
    zod: { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5', title: 'Zod can exhaust memory' }],
      nodes: ['node_modules/botbuilder/node_modules/zod', 'node_modules/botframework-schema/node_modules/zod'] },
    'botframework-schema': { severity: 'high', via: ['zod'], nodes: ['node_modules/botframework-schema'] },
    botbuilder: { severity: 'high', via: ['botframework-schema', 'zod'], nodes: ['node_modules/botbuilder'] },
    ...extra,
  },
});
const exception = { folder: '.', advisory: 'GHSA-mrhx-c7xc-m3w5', package: 'zod', under: ['botbuilder', 'botframework-schema'], reason: 'test', reviewBy: '2027-01-31' };

test('an exception accepts its advisory where it sits, and the packages flagged only for it', () => {
  const { open, accepted, expired } = auditFindings(zodUnderBotbuilder(), [exception], '.', '2026-10-24');
  assert.deepEqual(open, []);
  assert.deepEqual(accepted.sort(), ['botbuilder', 'botframework-schema', 'zod']);
  assert.deepEqual(expired, []);
});

test('an exception does not reach another folder, another place, or another advisory', () => {
  assert.equal(auditFindings(zodUnderBotbuilder(), [exception], 'web', '2026-10-24').open.length, 3);
  const topLevel = zodUnderBotbuilder();
  topLevel.vulnerabilities.zod.nodes.push('node_modules/zod');
  assert.deepEqual(auditFindings(topLevel, [exception], '.', '2026-10-24').open.map((v) => v.name).sort(), ['botbuilder', 'botframework-schema', 'zod']);
  const second = zodUnderBotbuilder();
  second.vulnerabilities.botbuilder.via.push({ url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx', title: 'new' });
  assert.deepEqual(auditFindings(second, [exception], '.', '2026-10-24').open.map((v) => v.name), ['botbuilder']);
  const other = auditFindings(zodUnderBotbuilder({ leftpad: { severity: 'low', via: [{ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }], nodes: ['node_modules/leftpad'] } }), [exception], '.', '2026-10-24');
  assert.deepEqual(other.open.map((v) => v.name), ['leftpad']);
});

test('an exception past its review date fails until it is looked at again', () => {
  const { open, expired } = auditFindings(zodUnderBotbuilder(), [exception], '.', '2027-02-01');
  assert.equal(expired.length, 1);
  assert.equal(open.length, 3);
});

test('the committed exceptions name an advisory, a package, its parents, a reason and a review date', () => {
  const committed = JSON.parse(readFileSync(new URL('./audit-exceptions.json', import.meta.url), 'utf8'));
  for (const e of committed) {
    assert.match(e.advisory, /^GHSA-/);
    assert.ok(e.package && Array.isArray(e.under) && e.under.length > 0 && e.reason, JSON.stringify(e));
    assert.match(e.reviewBy, /^\d{4}-\d{2}-\d{2}$/);
  }
});
