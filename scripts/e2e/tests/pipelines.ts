import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testPipelines(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mPipelines\x1b[0m');
  let templateId: string | null = null;

  await runner.test('GET /pipelines/templates returns template list', async () => {
    const { status, data } = await client.request<{ templates: unknown[] }>('GET', '/pipelines/templates');
    assertStatus(status, 200);
    assert(Array.isArray(data.templates), 'templates should be an array');
  });

  await runner.test('POST /pipelines/templates creates template', async () => {
    const { status, data } = await client.request<{ id: string; name: string }>(
      'POST', '/pipelines/templates', {
        name: 'E2E Test Pipeline',
        description: 'Test template',
        steps: [
          { name: 'Step 1', topic: 'general' },
          { name: 'Step 2', topic: 'coding', requiresApproval: true },
        ],
      },
    );
    assertStatus(status, 200);
    assert(!!data.id, 'No template ID returned');
    templateId = data.id;
  });

  await runner.test('PUT /pipelines/templates/:id updates template', async () => {
    if (!templateId) throw new Error('No template to update');
    const { status, data } = await client.request<{ id: string; name: string }>(
      'PUT', `/pipelines/templates/${templateId}`, {
        name: 'E2E Test Pipeline (Updated)',
        steps: [{ name: 'Updated Step', topic: 'research' }],
      },
    );
    assertStatus(status, 200);
    assert(data.name === 'E2E Test Pipeline (Updated)', 'Name not updated');
  });

  await runner.test('DELETE /pipelines/templates/:id deletes template', async () => {
    if (!templateId) throw new Error('No template to delete');
    const { status, data } = await client.request<{ deleted: boolean }>(
      'DELETE', `/pipelines/templates/${templateId}`,
    );
    assertStatus(status, 200);
    assert(data.deleted === true, 'Template not deleted');
  });

  await runner.test('GET /pipelines returns pipeline runs', async () => {
    const { status, data } = await client.request<{ pipelines: unknown[] }>('GET', '/pipelines');
    assertStatus(status, 200);
    assert(Array.isArray(data.pipelines), 'pipelines should be an array');
  });
}
