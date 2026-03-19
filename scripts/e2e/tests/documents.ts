import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testDocuments(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mDocuments\x1b[0m');

  await runner.test('GET /documents returns document list', async () => {
    const { status, data } = await client.request<{ documents: unknown[]; queue: unknown }>('GET', '/documents');
    assertStatus(status, 200);
    assert(Array.isArray(data.documents), 'documents should be an array');
    assert(data.queue !== undefined, 'queue status should be present');
  });

  await runner.test('GET /documents supports category filter', async () => {
    const { status, data } = await client.request<{ documents: unknown[] }>('GET', '/documents?category=invoices');
    assertStatus(status, 200);
    assert(Array.isArray(data.documents), 'documents should be an array');
  });

  await runner.test('GET /documents supports status filter', async () => {
    const { status, data } = await client.request<{ documents: unknown[] }>('GET', '/documents?status=processed');
    assertStatus(status, 200);
    assert(Array.isArray(data.documents), 'documents should be an array');
  });

  await runner.test('GET /documents supports limit parameter', async () => {
    const { status, data } = await client.request<{ documents: unknown[] }>('GET', '/documents?limit=5');
    assertStatus(status, 200);
    assert(Array.isArray(data.documents), 'documents should be an array');
  });

  await runner.test('GET /documents/:id returns 404 for unknown document', async () => {
    const { status, data } = await client.request<{ error?: string }>('GET', '/documents/00000000-0000-0000-0000-000000000000');
    assertStatus(status, 404);
    assert(!!data.error, 'Expected error message');
  });

  await runner.test('POST /documents/upload rejects request without files', async () => {
    // Send empty JSON body — should fail validation
    const { status } = await client.request<unknown>('POST', '/documents/upload', {});
    assert(status >= 400, `Expected 4xx status for missing files, got ${status}`);
  });
}
