import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withToolDeadline } from '../dist/tool-deadline.js';
test('MCP tools return an explicit timeout instead of hanging for client hours', async () => {
  const result = await withToolDeadline(() => new Promise(() => {}), 10);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /outcome may be unknown/);
});
test('preserves successful values and actual failures', async () => {
  assert.equal(await withToolDeadline(() => 3), 3);
  await assert.rejects(withToolDeadline(() => { throw new Error('original failure'); }), /original failure/);
});
