import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSkillTools } from '../dist/tools/skills.js';

test('both skill update names forward only supplied fields and report failures', async () => {
  const handlers = new Map();
  const calls = [];
  registerSkillTools({ tool(name, _description, _schema, handler) { handlers.set(name, handler); } }, {
    async updateSkill(id, fields) { calls.push({ id, fields }); if (id === 'missing') throw new Error('Skill not found'); return { id, ...fields }; },
  });
  for (const name of ['update_skill', 'octipus_update_skill']) {
    const result = await handlers.get(name)({ skill_id: 'skill', content: 'Updated' });
    assert.deepEqual(JSON.parse(result.content[0].text), { id: 'skill', content: 'Updated' });
    assert.deepEqual(calls.at(-1), { id: 'skill', fields: { content: 'Updated' } });
    const failure = await handlers.get(name)({ skill_id: 'missing', content: 'x' });
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /Skill not found/);
  }
});
