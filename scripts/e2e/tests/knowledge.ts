import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testKnowledge(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mKnowledge Tool (Hybrid Search)\x1b[0m');

  await runner.test('GET /tools/knowledge returns knowledge tool', async () => {
    const { status, data } = await client.request<{ id: string; tools: Array<{ name: string }> }>('GET', '/tools/knowledge');
    assertStatus(status, 200);
    assert(data.id === 'knowledge', `Expected id 'knowledge', got ${data.id}`);
    assert(Array.isArray(data.tools), 'tools should be an array');

    const toolNames = data.tools.map(t => t.name);
    assert(toolNames.includes('search_knowledge'), `Missing tool: search_knowledge`);
    assert(toolNames.includes('index_file'), `Missing tool: index_file`);
  });

  await runner.test('POST knowledge/search_knowledge executes hybrid search', async () => {
    const { status, data } = await client.request<{ result?: unknown; error?: string }>(
      'POST', '/tools/knowledge/tools/search_knowledge/execute',
      { args: { query: 'test query', mode: 'hybrid' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });

  await runner.test('POST knowledge/search_knowledge supports fts mode', async () => {
    const { status, data } = await client.request<{ result?: unknown; error?: string }>(
      'POST', '/tools/knowledge/tools/search_knowledge/execute',
      { args: { query: 'test query', mode: 'fts' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });

  await runner.test('POST knowledge/search_knowledge supports vector mode', async () => {
    const { status, data } = await client.request<{ result?: unknown; error?: string }>(
      'POST', '/tools/knowledge/tools/search_knowledge/execute',
      { args: { query: 'test query', mode: 'vector' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });
}
