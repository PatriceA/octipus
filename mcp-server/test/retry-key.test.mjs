import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { ApiError, OctiClient } from '../dist/client.js';
import { registerChatTools } from '../dist/tools/chat.js';
import { registerAgentTools } from '../dist/tools/agents.js';
import { registerTasksTools } from '../dist/tools/tasks.js';

function capture(register, client) {
  const handlers = new Map();
  register({ tool(name, _description, _schema, handler) { handlers.set(name, handler); } }, client);
  return handlers;
}
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

test('octipus_chat always sends a key and, on a client timeout, tells the model to retry with it', async () => {
  const keys = [];
  let fail = timeout;
  const chat = capture(registerChatTools, {
    async chat(_message, _sessionId, key) { keys.push(key); if (fail) throw fail(); return { response: 'hi', sessionId: 's1' }; },
  }).get('octipus_chat');
  const timedOut = await chat({ message: 'build it' });
  assert.equal(timedOut.isError, undefined);
  assert.match(timedOut.content[0].text, /may still be working/);
  assert.ok(keys[0], 'a key was generated');
  assert.match(timedOut.content[0].text, new RegExp(`clientRequestId "${keys[0]}"`));
  // The model's retry carries the key it was given; the server joins the turn.
  fail = () => new ApiError('API POST /api/chat failed: 409', 409, { code: 'idempotency_in_progress', sessionId: 's1' });
  const busy = await chat({ message: 'build it', clientRequestId: keys[0] });
  assert.equal(keys[1], keys[0]);
  assert.match(busy.content[0].text, /still working on this request in session s1/);
  fail = null;
  const done = await chat({ message: 'build it', clientRequestId: keys[0] });
  assert.match(done.content[0].text, /^hi/);
  // An ordinary failure is still reported as one.
  fail = () => new ApiError('API POST /api/chat failed: 500', 500, {});
  assert.equal((await chat({ message: 'x' })).isError, true);
});

test('octipus_spawn_agent and octipus_create_task pass the caller key through', async () => {
  const seen = [];
  const spawn = capture(registerAgentTools, {
    async spawnAgent(message, model, topic, key) { seen.push(key); return { id: 'a1', sessionId: 's', status: 'running' }; },
  }).get('octipus_spawn_agent');
  await spawn({ message: 'go', clientRequestId: 'k-agent' });
  const create = capture(registerTasksTools, {
    async executeTool(toolId, name, args, key) { seen.push(key); assert.equal(args.clientRequestId, undefined); return { id: 't1' }; },
  }).get('octipus_create_task');
  await create({ title: 'milk', clientRequestId: 'k-task' });
  assert.deepEqual(seen, ['k-agent', 'k-task']);
});

test('the client sends Idempotency-Key, keys the helper session, and surfaces 409 bodies', async t => {
  const previousKey = process.env.OCTIPUS_API_KEY;
  process.env.OCTIPUS_API_KEY = 'backend-test-token';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OCTIPUS_API_KEY;
    else process.env.OCTIPUS_API_KEY = previousKey;
  });
  const calls = [];
  const backend = createServer((req, res) => {
    calls.push({ path: req.url, key: req.headers['idempotency-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/chat') {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: 'idempotency_in_progress', sessionId: 's9' }));
      return;
    }
    res.end(JSON.stringify(req.url === '/api/sessions' ? { id: 'sess' } : { id: 'agent', sessionId: 'sess' }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const client = new OctiClient(`http://127.0.0.1:${backend.address().port}`);
  await client.spawnAgent('go', undefined, undefined, 'k1');
  await client.spawnAgent('go');
  await assert.rejects(client.chat('hi', undefined, 'k2'), error => error instanceof ApiError && error.status === 409 && error.body.sessionId === 's9');
  assert.deepEqual(calls, [
    { path: '/api/sessions', key: 'k1:session' },
    { path: '/api/agents', key: 'k1' },
    { path: '/api/sessions', key: undefined },
    { path: '/api/agents', key: undefined },
    { path: '/api/chat', key: 'k2' },
  ]);
});
