import type { Page, Request } from '@playwright/test';
import type { SkillProposalView } from '../../src/shared/skill-proposals';
import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

/** The skill-proposals review page against stubbed `/api/skills/proposals/**` routes. */

const NOW = '2026-11-20T10:00:00Z';

function proposal(over: Partial<SkillProposalView> & Pick<SkillProposalView, 'id' | 'name'>): SkillProposalView {
  return {
    userId: 'e2e-user-id', fingerprint: `fp-${over.id}`, description: `About ${over.name}`,
    draftPromptTemplate: `# ${over.name}\n1. Do the thing.\n`, exemplarCount: 1, lastExemplarAt: NOW,
    kind: 'skill', sourceRef: null, status: 'pending', createdAt: NOW, targetSkillId: null,
    patchOldText: null, patchNewText: null, baseContentHash: null, promotedSkillId: null,
    sourceRefs: [], sessionCount: 1, signal: 'procedure', previousDraft: null, surfacedAt: NOW,
    mergedIntoId: null, similarSkill: null, ...over,
  };
}

const PENDING: SkillProposalView[] = [
  proposal({ id: 'p-release', name: 'release-checklist', description: 'Tag, build and publish a release in order',
    exemplarCount: 5, sessionCount: 3, sourceRefs: ['session:a', 'session:b', 'session:c'],
    similarSkill: { id: 's-deploy', name: 'deploy-service', similarity: 0.874 } }),
  proposal({ id: 'p-migrate', name: 'db-migration-review', description: 'Check a migration for locks before running it',
    exemplarCount: 2, sessionCount: 1, signal: 'correction', sourceRefs: ['session:a', 'session:a'],
    previousDraft: '# db-migration-review\n1. Read the migration.\n',
    draftPromptTemplate: '# db-migration-review\n1. Read the migration.\n2. Look for ACCESS EXCLUSIVE locks.\n' }),
  proposal({ id: 'p-flaky', name: 'flaky-test-triage', description: 'Rerun a failing test alone before changing code',
    exemplarCount: 1, sessionCount: 1, sourceRef: 'skill_distill' }),
];

const CANDIDATES: SkillProposalView[] = [
  proposal({ id: 'c-lint', name: 'lint-before-commit', status: 'candidate', surfacedAt: null }),
  proposal({ id: 'c-env', name: 'env-var-audit', status: 'candidate', surfacedAt: null, kind: 'expert' }),
];

const isProposalsList = (url: URL) => url.pathname === '/api/skills/proposals';

async function stubProposals(page: Page, pending = PENDING, candidates = CANDIDATES): Promise<void> {
  await page.route(isProposalsList, (route) => {
    const url = new URL(route.request().url());
    const withCandidates = url.searchParams.get('include') === 'candidates';
    return json(route, 200, { proposals: withCandidates ? [...pending, ...candidates] : pending, candidateCount: candidates.length });
  });
}

/** Records POST bodies sent to one action path. */
function capture(page: Page, pattern: string, status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  void page.route(pattern, (route) => {
    const req: Request = route.request();
    calls.push({ url: req.url(), body: req.postDataJSON() });
    return json(route, status, body);
  });
  return calls;
}

const card = (page: Page, name: string) => page.getByRole('article', { name, exact: true });

test.describe('skill proposals page', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubProposals(page);
  });

  test('cards keep the served order and say how often each was seen', async ({ authenticatedPage: page }) => {
    await page.goto('/skills/proposals');
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText('release-checklist');
    await expect(cards.nth(1)).toContainText('db-migration-review');
    await expect(cards.nth(2)).toContainText('flaky-test-triage');
    await expect(cards.nth(0)).toContainText('seen 5× in 3 sessions');
    await expect(cards.nth(1)).toContainText('seen 2× in 1 session');
    await expect(cards.nth(2)).not.toContainText('seen 1×');
    await expect(cards.nth(2)).toContainText('first drafted from: skill_distill');
    await expect(cards.nth(1)).toContainText('from your correction');
    await expect(cards.nth(0)).not.toContainText('from your correction');
  });

  test('a proposal close to a live skill names it with the similarity', async ({ authenticatedPage: page }) => {
    await page.goto('/skills/proposals');
    const link = card(page, 'release-checklist').getByRole('link', { name: 'similar to skill deploy-service (87%)' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/skills');
    await expect(card(page, 'flaky-test-triage')).not.toContainText('similar to skill');
  });

  test('a merged proposal shows its draft diff, collapsed', async ({ authenticatedPage: page }) => {
    await page.goto('/skills/proposals');
    const merged = card(page, 'db-migration-review');
    const added = merged.getByText('+2. Look for ACCESS EXCLUSIVE locks.');
    await expect(added).toBeHidden();
    await merged.getByText('Updated by a merge: what changed in the draft').click();
    await expect(added).toBeVisible();
    await expect(card(page, 'release-checklist')).not.toContainText('Updated by a merge');
  });

  test('reject selected sends the selected ids', async ({ authenticatedPage: page }) => {
    const calls = capture(page, '**/api/skills/proposals/bulk-reject', 200, { rejected: ['p-release', 'p-flaky'], notFound: [] });
    await page.goto('/skills/proposals');
    const bulk = page.getByRole('button', { name: /Reject selected/ });
    await expect(bulk).toHaveText(/\(0\)/);
    await expect(bulk).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Select release-checklist' }).check();
    await page.getByRole('checkbox', { name: 'Select flaky-test-triage' }).check();
    await expect(page.getByRole('button', { name: 'Reject selected (2)' })).toBeEnabled();
    await page.getByRole('button', { name: 'Reject selected (2)' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].body).toEqual({ ids: ['p-release', 'p-flaky'] });
    await expect(page.getByRole('button', { name: 'Reject selected (0)' })).toBeVisible();

    await page.getByRole('checkbox', { name: 'Select all proposals' }).check();
    await page.getByRole('button', { name: 'Reject selected (3)' }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1].body).toEqual({ ids: ['p-release', 'p-migrate', 'p-flaky'] });
  });

  test('merge into sends the chosen target', async ({ authenticatedPage: page }) => {
    const calls = capture(page, '**/api/skills/proposals/*/merge', 200, PENDING[0]);
    await page.goto('/skills/proposals');
    const source = card(page, 'flaky-test-triage');
    const merge = source.getByRole('button', { name: 'Merge' });
    await expect(merge).toBeDisabled();
    const select = source.getByRole('combobox', { name: 'Merge flaky-test-triage into' });
    await expect(select.locator('option')).toHaveText(['Merge into…', 'release-checklist', 'db-migration-review']);
    await select.selectOption({ label: 'release-checklist' });
    await merge.click();
    await expect.poll(() => calls.length).toBe(1);
    expect(new URL(calls[0].url).pathname).toBe('/api/skills/proposals/p-flaky/merge');
    expect(calls[0].body).toEqual({ intoId: 'p-release' });
  });

  test('merge into is not offered on a patch proposal', async ({ authenticatedPage: page }) => {
    const patch = proposal({ id: 'p-patch', name: 'deploy-service', kind: 'patch', targetSkillId: 's-deploy',
      patchOldText: '2. Push it.', patchNewText: '2. Push it with --tag.', currentContent: '1. Build.\n2. Push it.\n',
      draftPromptTemplate: '1. Build.\n2. Push it with --tag.\n', stale: false });
    await stubProposals(page, [...PENDING, patch]);
    await page.goto('/skills/proposals');
    await expect(card(page, 'deploy-service').getByRole('combobox')).toHaveCount(0);
    await expect(card(page, 'release-checklist').getByRole('combobox').locator('option')).toHaveText(['Merge into…', 'db-migration-review', 'flaky-test-triage']);
  });

  test('consolidate now shows its report as one sentence', async ({ authenticatedPage: page }) => {
    let report = { merged: 6, expired: 2, promoted: 1, embedded: 4, degraded: 0 };
    await page.route('**/api/skills/proposals/consolidate', (route) => json(route, 200, report));
    await page.goto('/skills/proposals');
    const button = page.getByRole('button', { name: 'Consolidate now' });
    await button.click();
    await expect(page.getByRole('status')).toHaveText('Merged 6 proposals, removed 2 unseen candidates and showed 1 candidate that had recurred.');

    report = { merged: 1, expired: 0, promoted: 0, embedded: 0, degraded: 1 };
    await button.click();
    await expect(page.getByRole('status')).toHaveText('Merged 1 proposal; 1 merge was only counted, not rewritten, because the model was unavailable.');

    report = { merged: 0, expired: 0, promoted: 0, embedded: 3, degraded: 0 };
    await button.click();
    await expect(page.getByRole('status')).toHaveText('Nothing to consolidate.');
  });

  test('the candidates section loads on open and show now surfaces one', async ({ authenticatedPage: page }) => {
    const listUrls: string[] = [];
    page.on('request', (req) => { if (isProposalsList(new URL(req.url()))) listUrls.push(req.url()); });
    const surfaced = capture(page, '**/api/skills/proposals/*/surface');
    const rejected = capture(page, '**/api/skills/proposals/*/reject');
    await page.goto('/skills/proposals');
    await expect(page.getByRole('article')).toHaveCount(3);
    expect(listUrls.some((u) => u.includes('include=candidates'))).toBe(false);
    await expect(page.getByText('lint-before-commit')).toBeHidden();

    await page.getByText('Not shown yet (2)').click();
    await expect.poll(() => listUrls.some((u) => u.includes('include=candidates'))).toBe(true);
    await expect(page.getByText('These have not been seen in a second session yet')).toBeVisible();
    const rows = page.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await rows.filter({ hasText: 'lint-before-commit' }).getByRole('button', { name: 'Show now' }).click();
    await expect.poll(() => surfaced.length).toBe(1);
    expect(new URL(surfaced[0].url).pathname).toBe('/api/skills/proposals/c-lint/surface');

    await rows.filter({ hasText: 'env-var-audit' }).getByRole('button', { name: 'Reject' }).click();
    await expect.poll(() => rejected.length).toBe(1);
    expect(new URL(rejected[0].url).pathname).toBe('/api/skills/proposals/c-env/reject');
  });

  test('an approve refused with 409 shows the error', async ({ authenticatedPage: page }) => {
    await page.route('**/api/skills/proposals/*/approve', (route) =>
      json(route, 409, { error: 'A skill named release-checklist already exists', code: 'skill_exists' }));
    await page.goto('/skills/proposals');
    const approve = card(page, 'release-checklist').getByRole('button', { name: 'Approve' });
    await approve.click();
    await expect(page.getByRole('alert')).toHaveText('A skill named release-checklist already exists');
    await expect(approve).toBeEnabled();
  });
});
