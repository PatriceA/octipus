import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';
import { stubGateway } from './fixtures/gateway';

const sessions = { sessions: [{ id: 'sess-2', title: 'Second chat', channelType: 'web', status: 'active', messageCount: 1, updatedAt: '2026-10-15T10:00:00Z' }] };

test('dashboard resumes the selected conversation', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  await page.route('**/api/sessions?*', route => json(route, 200, sessions));
  await page.route('**/api/sessions/sess-2/messages**', route => json(route, 200, { messages: [{ id: 'm2', role: 'user', content: 'Continue our launch plan', createdAt: '2026-10-15T10:00:00Z' }] }));
  await page.goto('/');
  await page.getByRole('link', { name: 'Second chat', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?session=sess-2$/);
  await expect(page.getByText('Continue our launch plan', { exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Work navigation' });
  await expect(nav.getByRole('link', { name: 'Conversations' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Shared rooms' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/octipus-work-flow-mobile.png' });
});

test('dashboard distinguishes failed loading from an empty history and can retry', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  let failed = true;
  await page.route('**/api/sessions?*', route => json(route, failed ? 400 : 200, failed ? { error: 'Unavailable' } : sessions));
  await page.goto('/');
  await expect(page.getByText('Could not load recent conversations.')).toBeVisible();
  await expect(page.getByText('Your conversations will appear here.')).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Second chat', exact: true })).toBeVisible();
});

test('research returns to the same report after navigation and reload without starting again', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  let starts = 0;
  let reads = 0;
  await page.route('**/api/research', route => { starts++; return json(route, 200, { jobId: 'job-1' }); });
  await page.route('**/api/research/job-1', route => {
    reads++;
    return json(route, 200, { id: 'job-1', status: 'done', stage: 'done', documentId: 'doc-1', report: { question: 'How should we launch?', depth: 'standard', generatedAt: '2026-10-15T10:00:00Z', sections: [{ heading: 'Recommendation', markdown: 'Start with a small pilot.', citations: [] }], sources: [], limitations: '' } });
  });
  await page.goto('/research');
  await page.getByRole('textbox', { name: 'Research question' }).fill('How should we launch?');
  await page.getByRole('button', { name: 'Start research', exact: true }).click();
  await expect(page).toHaveURL(/\/research\?job=job-1$/);
  await expect(page.getByText('Start with a small pilot.')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Work navigation' });
  await page.getByRole('link', { name: 'Saved to Documents' }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await nav.getByRole('link', { name: 'Research', exact: true }).click();
  await expect(page).toHaveURL(/\/research\?job=job-1$/);
  await expect(page.getByText('Start with a small pilot.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Start with a small pilot.')).toBeVisible();
  expect(starts).toBe(1);
  expect(reads).toBe(3);
  await page.screenshot({ path: '/tmp/octipus-work-flow-research.png' });
});

test('an unavailable investigation stops polling and offers an explicit status retry', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  let reads = 0;
  await page.route('**/api/research/missing', route => { reads++; return json(route, 404, { error: 'Not found' }); });
  await page.goto('/research?job=missing');
  await expect(page.getByText('This investigation is unavailable or you do not have access to it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start research', exact: true })).toBeEnabled();
  await page.waitForTimeout(1700);
  expect(reads).toBe(1);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect.poll(() => reads).toBe(2);
});

for (const kind of ['shared', 'remote'] as const) {
  test(`${kind} workspace navigation stays within supported work surfaces`, async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    await page.addInitScript(() => localStorage.setItem('octipus.activeWorkspace', 'space-flow'));
    if (kind === 'shared') {
      await page.route('**/api/spaces', route => json(route, 200, { spaces: [{ id: 'space-flow', name: 'Team studio', slug: 'studio', role: 'editor', memberCount: 2, archivedAt: null, funding: 'own' }] }));
    } else {
      await page.route('**/api/remote-spaces', route => json(route, 200, { remoteSpaces: [{ id: 'space-flow', hostInstanceId: 'host-1', hostBadge: '[B:abcd1234]', hostFingerprint: 'abcd', hostUrl: 'https://host.example', spaceId: 'host-space', spaceName: 'Remote studio', role: 'editor', memberHandle: 'me', joinedAt: '2026-10-15T10:00:00Z', leftAt: null, link: 'up' }], pendingLeaves: [] }));
    }
    await page.goto('/research');
    const nav = page.getByRole('navigation', { name: 'Work navigation' });
    await expect(nav.getByRole('link', { name: 'Shared rooms' })).toBeVisible();
    await expect(nav.getByText('Research here is personal.', { exact: false })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Documents', exact: true })).toHaveCount(kind === 'remote' ? 0 : 1);
    await expect(nav.getByRole('link', { name: 'Next steps' })).toHaveAttribute('href', '/tasks');
  });
}
