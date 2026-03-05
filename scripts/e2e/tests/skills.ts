import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testSkills(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mSkills\x1b[0m');

  let systemSkillId: string | null = null;
  let customSkillId: string | null = null;

  await runner.test('GET /skills returns system skills', async () => {
    const { status, data } = await client.request<{
      skills: Array<{ id: string; name: string; category: string; isSystem: boolean }>;
    }>('GET', '/skills');
    assertStatus(status, 200);
    assert(Array.isArray(data.skills), 'skills should be an array');
    assert(data.skills.length >= 10, `Expected at least 10 system skills, got ${data.skills.length}`);

    const systemSkills = data.skills.filter(s => s.isSystem);
    assert(systemSkills.length >= 10, `Expected at least 10 system skills, got ${systemSkills.length}`);

    const names = data.skills.map(s => s.name);
    assert(names.includes('Software Architecture'), 'Expected Software Architecture skill');
    assert(names.includes('Security Practices'), 'Expected Security Practices skill');

    systemSkillId = systemSkills[0].id;
  });

  await runner.test('GET /skills/:id returns a specific skill', async () => {
    if (!systemSkillId) return;
    const { status, data } = await client.request<{
      id: string; name: string; category: string; principles: string[];
    }>('GET', `/skills/${systemSkillId}`);
    assertStatus(status, 200);
    assert(!!data.id, 'Expected skill id');
    assert(!!data.name, 'Expected skill name');
    assert(Array.isArray(data.principles), 'Expected principles array');
  });

  await runner.test('POST /skills creates a custom skill', async () => {
    const { status, data } = await client.request<{
      id: string; name: string; category: string; isSystem: boolean;
    }>('POST', '/skills', {
      name: 'E2E Test Skill',
      description: 'Created by e2e test suite',
      category: 'testing',
      principles: ['Test first', 'Verify always'],
      bestPractices: ['Use assertions'],
      antiPatterns: ['Skip tests'],
    });
    assertStatus(status, 200);
    assert(!!data.id, 'Expected skill id');
    assert(data.name === 'E2E Test Skill', `Expected name "E2E Test Skill", got "${data.name}"`);
    assert(data.isSystem === false, 'Custom skill should not be system');
    customSkillId = data.id;
  });

  await runner.test('PATCH /skills/:id updates a skill', async () => {
    if (!customSkillId) return;
    const { status, data } = await client.request<{
      id: string; name: string;
    }>('PATCH', `/skills/${customSkillId}`, {
      name: 'E2E Updated Skill',
    });
    assertStatus(status, 200);
    assert(data.name === 'E2E Updated Skill', `Expected updated name, got "${data.name}"`);
  });

  await runner.test('DELETE /skills/:id rejects deleting system skills', async () => {
    if (!systemSkillId) return;
    const { status, data } = await client.request<{ error?: string }>(
      'DELETE', `/skills/${systemSkillId}`,
    );
    assert(status === 200 || status === 403, `Unexpected status ${status}`);
    if (status === 200) {
      assert(!!(data as any).error, 'Expected error for system skill deletion');
    }
  });

  await runner.test('DELETE /skills/:id deletes a custom skill', async () => {
    if (!customSkillId) return;
    const { status, data } = await client.request<{ deleted?: boolean }>(
      'DELETE', `/skills/${customSkillId}`,
    );
    assertStatus(status, 200);
    assert(data.deleted === true, 'Expected deleted: true');
    customSkillId = null;
  });
}
