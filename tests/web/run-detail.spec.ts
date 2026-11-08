import type { Page } from '@playwright/test';
import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const now = new Date().toISOString();
const section = (category: string, label: string, tokens: number, text?: string) => ({ category, tier: category === 'conversation' ? 'history' : 'static', label, tokens, chars: tokens * 4, ...(text ? { text } : {}) });
const run = {
  id: 'w1', role: 'writing', root: false, status: 'completed', sessionId: 's1', sessionTitle: 'Release notes', createdAt: now,
  origin: { source: 'heartbeat', channel: 'heartbeat', hookId: 'hb' },
  chain: [
    { kind: 'source', label: 'Heartbeat', detail: 'heartbeat', href: null },
    { kind: 'hook', label: 'writing heartbeat', detail: 'heartbeat', href: '/agents/triggers' },
    { kind: 'heartbeat', label: 'Heartbeat check passed', detail: '2 ready to-dos', href: '/agents/triggers' },
    { kind: 'parent', label: 'Octipus', detail: 'spawned this run', href: '/agents/view?id=root1' },
  ],
  parent: { id: 'root1', role: 'general', root: true },
  children: [{ id: 'c1', role: 'research', status: 'running', totalTokens: 12_000 }],
  prompt: {
    version: 1, role: 'writing', model: 'm', measuredAt: now, contextWindow: 200_000, textAvailable: true,
    totals: { tokens: 1500, chars: 6000, prefixTokens: 1200, turnTokens: 300, historyTokens: 0 },
    sections: [section('role', 'writing role prompt', 1200, 'You write.'), section('turn', 'Brief', 300, 'YOUR TASK: draft release notes')],
  },
};
async function stubPage(page: Page) {
  await page.route('**/api/agents/*/events**', (route) => json(route, 200, { source: 'persisted', events: [], nextCursor: 0, hasMore: false }));
  await page.route('**/api/verification/**', (route) => json(route, 200, { sessionId: 's1', verified: false, evidence: [] }));
  await page.route('**/api/pipelines', (route) => json(route, 200, { pipelines: [] }));
}
const agent = { id: 'w1', sessionId: 's1', userId: 'u', topic: 'writing', model: 'm', status: 'completed', iteration: 2, createdAt: now, metadata: {} };

test('the run view says why the run exists, shows its tree and what its prompt held', async ({ authenticatedPage: page }) => {
  await page.route('**/api/agents/w1/run', (route) => json(route, 200, run));
  await page.route('**/api/agents/w1', (route) => json(route, 200, agent));
  await stubPage(page);
  await page.goto('/agents/view?id=w1');

  const why = page.getByRole('region', { name: 'Why this run exists' });
  await expect(why).toContainText('Heartbeat check passed · 2 ready to-dos');
  await expect(why.getByRole('link', { name: 'writing heartbeat' })).toHaveAttribute('href', '/agents/triggers');
  await expect(why).toContainText('this run — Release notes');
  const tree = page.getByRole('list', { name: 'Run tree' });
  await expect(tree.getByRole('link', { name: 'Octipus' })).toHaveAttribute('href', '/agents/view?id=root1');
  await expect(tree.getByRole('link', { name: 'research' })).toHaveAttribute('href', '/agents/view?id=c1');
  await expect(tree).toContainText('running · 12k tokens');

  const prompt = page.getByRole('region', { name: 'Prompt' });
  await expect(prompt).toContainText('~1,500 of 200k');
  await prompt.getByRole('button', { name: /^Turn context/, expanded: false }).click();
  await prompt.getByRole('button', { name: 'Read' }).click();
  await expect(page.getByText('YOUR TASK: draft release notes')).toBeVisible();
});

test('an unmeasured run from before origins says so', async ({ authenticatedPage: page }) => {
  await page.route('**/api/agents/old/run', (route) => json(route, 200, { ...run, id: 'old', chain: [], parent: null, children: [], prompt: null }));
  await page.route('**/api/agents/old', (route) => json(route, 200, { ...agent, id: 'old' }));
  await stubPage(page);
  await page.goto('/agents/view?id=old');
  await expect(page.getByRole('region', { name: 'Why this run exists' })).toContainText('what started it is not known');
  await expect(page.getByRole('region', { name: 'Prompt' })).toContainText('was not measured');
});
