import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const skill = { id: 'external:agents-user:shared:SKILL', name: 'Shared skill', category: 'general', description: 'One skill, two sources',
  content: 'Full instructions', principles: [], bestPractices: [], antiPatterns: [], frameworks: [], isSystem: true,
  mounted: true, canEdit: false, canDelete: true, removeOnly: true,
  sources: [{ id: 'agents', location: 'agents-user', path: '/home/.agents/skills/shared/SKILL.md' },
    { id: 'claude', location: 'claude-user', path: '/home/.claude/skills/shared/SKILL.md' }] };

test('mounted skills show all sources and can be removed without an edit action', async ({ authenticatedPage: page }) => {
  let removed = false;
  await page.route('**/api/skills', route => json(route, 200, { skills: removed ? [] : [skill] }));
  await page.route('**/api/skills/external*', route => {
    expect(route.request().method()).toBe('DELETE'); removed = true;
    return json(route, 200, { deleted: true, removal: 'personal' });
  });
  await page.goto('/skills');
  await page.getByRole('button', { name: /Shared skill One skill/ }).click();
  await expect(page.getByText('Sources (duplicates combined)')).toBeVisible();
  await expect(page.getByText('/home/.claude/skills/shared/SKILL.md', { exact: false })).toBeVisible();
  await expect(page.getByTitle('Edit skill')).toHaveCount(0);
  await page.getByTitle('Remove from Octipus').click();
  await expect(page.getByText(/Shared source files and other users are unaffected/)).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared skill' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Shared skill' })).toHaveCount(0);
});

test('owned skill deletion keeps the dialog open when the server reports failure', async ({ authenticatedPage: page }) => {
  await page.route('**/api/skills', route => json(route, 200, { skills: [{ ...skill, id: 'owned', mounted: false, isSystem: false, removeOnly: false }] }));
  await page.route('**/api/skills/owned', route => json(route, 200, { error: 'Deletion rejected' }));
  await page.goto('/skills');
  await page.getByTitle('Delete skill').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Deletion rejected')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delete Skill' })).toBeVisible();
});
