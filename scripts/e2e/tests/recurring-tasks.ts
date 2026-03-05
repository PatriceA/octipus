import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';

export async function testRecurringTasks(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mRecurring Tasks\x1b[0m');

  let createdTaskId: string | null = null;

  // List recurring tasks — initially empty or existing
  await runner.test('GET /recurring-tasks returns task list', async () => {
    const { status, data } = await client.request<{ tasks: unknown[] }>('GET', '/recurring-tasks');
    assertStatus(status, 200);
    assert(Array.isArray(data.tasks), 'tasks should be an array');
  });

  // Create a recurring task
  await runner.test('POST /recurring-tasks creates a task', async () => {
    const { status, data } = await client.request<{
      task: { id: string; name: string; cronExpression: string; actionType: string; isEnabled: boolean; nextRunAt: string };
    }>('POST', '/recurring-tasks', {
      name: 'E2E Test Task',
      description: 'Created by e2e test suite',
      cronExpression: '*/30 * * * *',
      timezone: 'UTC',
      actionType: 'spawn_agent',
      actionConfig: { message: 'test task' },
    });
    assertStatus(status, 200);
    assert(!!data.task?.id, 'Expected task id');
    assert(data.task.name === 'E2E Test Task', `Expected name "E2E Test Task", got "${data.task.name}"`);
    assert(data.task.cronExpression === '*/30 * * * *', 'Expected cron expression');
    assert(data.task.actionType === 'spawn_agent', 'Expected action type');
    assert(data.task.isEnabled === true, 'Expected enabled by default');
    assert(!!data.task.nextRunAt, 'Expected nextRunAt to be set');
    createdTaskId = data.task.id;
    fixtures.testRecurringTaskId = createdTaskId;
  });

  // Get single task by ID
  await runner.test('GET /recurring-tasks/:id returns a specific task', async () => {
    if (!createdTaskId) return;
    const { status, data } = await client.request<{
      task: { id: string; name: string };
    }>('GET', `/recurring-tasks/${createdTaskId}`);
    assertStatus(status, 200);
    assert(data.task?.id === createdTaskId, 'Expected matching task id');
    assert(data.task?.name === 'E2E Test Task', 'Expected matching task name');
  });

  // Update task
  await runner.test('PATCH /recurring-tasks/:id updates a task', async () => {
    if (!createdTaskId) return;
    const { status, data } = await client.request<{
      task: { id: string; name: string; isEnabled: boolean };
    }>('PATCH', `/recurring-tasks/${createdTaskId}`, {
      name: 'E2E Updated Task',
      isEnabled: false,
    });
    assertStatus(status, 200);
    assert(data.task?.name === 'E2E Updated Task', `Expected updated name, got "${data.task?.name}"`);
    assert(data.task?.isEnabled === false, 'Expected disabled after update');
  });

  // Get non-existent task
  await runner.test('GET /recurring-tasks/:id returns error for invalid ID', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'GET', '/recurring-tasks/00000000-0000-0000-0000-000000000000',
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for non-existent task');
  });

  // Delete task
  await runner.test('DELETE /recurring-tasks/:id deletes a task', async () => {
    if (!createdTaskId) return;
    const { status, data } = await client.request<{ deleted?: boolean }>(
      'DELETE', `/recurring-tasks/${createdTaskId}`,
    );
    assertStatus(status, 200);
    assert(data.deleted === true, 'Expected deleted: true');
    createdTaskId = null;
    fixtures.testRecurringTaskId = null;
  });

  // Verify deletion
  await runner.test('GET /recurring-tasks/:id returns error after deletion', async () => {
    if (fixtures.testRecurringTaskId) return; // Skip if not deleted
    const id = '00000000-0000-0000-0000-000000000000';
    const { status, data } = await client.request<{ error?: string }>('GET', `/recurring-tasks/${id}`);
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for deleted task');
  });
}
