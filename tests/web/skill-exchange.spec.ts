import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const own = { id: 'own-1', name: 'Release notes', category: 'writing', description: 'Write release notes', content: 'Lead with the change.',
  principles: [], bestPractices: [], antiPatterns: [], frameworks: [], isSystem: false, mounted: false, canEdit: true, canDelete: true, removeOnly: false };
const mounted = { ...own, id: 'external:agents-user:pdf:SKILL', name: 'PDF tools', description: 'Mounted', mounted: true, isSystem: true };

const bundle = { format: 'octipus-skill-bundle', version: 1, contentHash: `sha256:${'a'.repeat(64)}`, signature: null,
  skills: [{ name: 'Release notes', category: 'writing', description: 'Write release notes', content: 'Lead with the change.', principles: [], bestPractices: [], antiPatterns: [], frameworks: [] }] };

test('export downloads a bundle of the chosen skills; mounted skills are not offered', async ({ authenticatedPage: page }) => {
  await page.route('**/api/skills', route => json(route, 200, { skills: [own, mounted] }));
  let asked = '';
  await page.route('**/api/skills/exchange/export*', route => {
    asked = new URL(route.request().url()).searchParams.get('ids') ?? '';
    return json(route, 200, { bundle, signed: false, note: 'Unsigned: this Octipus holds no publisher signing key.' });
  });
  await page.goto('/skills');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export skills' });
  await expect(dialog.getByText('PDF tools')).toHaveCount(0);
  await dialog.getByLabel(/Release notes/).check();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Download 1 skill/ }).click();
  expect((await download).suggestedFilename()).toBe('Release_notes.skills.json');
  expect(asked).toBe('own-1');
  await expect(dialog.getByText(/Unsigned: this Octipus holds no publisher signing key/)).toBeVisible();
});

test('import previews the full content and the collision, and installs only the explicit choice', async ({ authenticatedPage: page }) => {
  await page.route('**/api/skills', route => json(route, 200, { skills: [own] }));
  let installed: Record<string, unknown> | null = null;
  await page.route('**/api/skills/exchange/preview', route => json(route, 200, {
    source: 'bundle', url: null, contentHash: bundle.contentHash, installable: true, refusal: null,
    signature: { status: 'unsigned', publisher: null, keyId: null, detail: 'Not signed' }, warnings: [],
    skills: [{ skill: bundle.skills[0], collision: { id: 'own-1', name: 'Release notes', kind: 'own', canReplace: true } }],
  }));
  await page.route('**/api/skills/exchange/install', route => {
    installed = route.request().postDataJSON();
    return json(route, 200, { created: [{ id: 'new-1', name: 'Release notes v2' }], replaced: [], skipped: [], contentHash: bundle.contentHash,
      signature: { status: 'unsigned', publisher: null, keyId: null, detail: 'Not signed' } });
  });
  await page.goto('/skills');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import skills' });
  await dialog.getByRole('tab', { name: 'Paste' }).click();
  await dialog.getByLabel('Bundle JSON or SKILL.md').fill(JSON.stringify(bundle));
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('Not signed')).toBeVisible();
  await expect(dialog.getByText(/A skill of yours is already named/)).toBeVisible();
  // A collision starts as "don't import": nothing would be written.
  await expect(dialog.getByRole('button', { name: /Install 0 skills/ })).toBeDisabled();
  await dialog.getByText('Full content').click();
  await expect(dialog.getByText('Lead with the change.', { exact: true })).toBeVisible();
  await dialog.getByLabel('What to do with Release notes').selectOption('rename');
  await dialog.getByLabel('New name for Release notes').fill('Release notes v2');
  await dialog.getByRole('button', { name: /Install 1 skill/ }).click();
  await expect(dialog.getByText('1 created, 0 replaced, 0 skipped.')).toBeVisible();
  expect(installed).toMatchObject({ bundle: JSON.stringify(bundle), contentHash: bundle.contentHash,
    decisions: [{ name: 'Release notes', action: 'rename', newName: 'Release notes v2' }] });
});

test('a bundle the trust settings refuse cannot be installed', async ({ authenticatedPage: page }) => {
  await page.route('**/api/skills', route => json(route, 200, { skills: [] }));
  await page.route('**/api/skills/exchange/preview', route => json(route, 200, {
    source: 'skill_md', url: null, contentHash: bundle.contentHash, installable: false,
    refusal: 'Not signed; plugins.requireSignature accepts only bundles signed by a trusted publisher',
    signature: { status: 'unsigned', publisher: null, keyId: null, detail: 'Not signed' }, warnings: [],
    skills: [{ skill: bundle.skills[0], collision: null }],
  }));
  await page.goto('/skills');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import skills' });
  await dialog.getByRole('tab', { name: 'Paste' }).click();
  await dialog.getByLabel('Bundle JSON or SKILL.md').fill('---\nname: x\ndescription: y\n---\nbody');
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText(/plugins.requireSignature accepts only bundles/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Install 1 skill/ })).toBeDisabled();
});
