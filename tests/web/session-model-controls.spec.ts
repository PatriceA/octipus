import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import type { SessionCliOverride } from '../../src/shared/session-model-controls';

test('CLI context belongs to a selected agent and current usage is separate from known payload', async ({
  authenticatedPage: page,
}) => {
  await page.route('**/api/sessions/sess-1/model-controls', (route) =>
    json(route, 200, {
      revision: 0,
      bindings: [],
      overrides: [],
      runs: [
        {
          id: 'root-run',
          root: true,
          role: 'general',
          topic: 'build',
          adapter: 'Codex CLI',
          model: 'actual-model',
          status: 'running',
          at: '2026-11-19T10:00:00Z',
        },
        {
          id: 'review-run',
          role: 'review',
          topic: 'verify',
          adapter: 'Claude Code',
          model: 'review-model',
          status: 'completed',
          at: '2026-11-19T10:01:00Z',
        },
      ],
    }),
  );
  await page.route('**/api/sessions/sess-1/context**', (route) => {
    const child = new URL(route.request().url()).searchParams.get('agentId') === 'review-run';
    return json(route, 200, {
      latest: {
        version: 1,
        source: 'cli-payload',
        resumed: true,
        role: child ? 'review' : 'general',
        model: 'actual-model',
        measuredAt: '2026-11-19T10:00:00Z',
        estimator: 'chars/4',
        toolCount: 2,
        textAvailable: true,
        sections: [
          {
            category: 'skills',
            tier: 'static',
            label: 'Selected skills',
            chars: 400,
            tokens: 100,
            text: 'Loaded skill text',
          },
        ],
        totals: { tokens: 100, prefixTokens: 100, historyTokens: 0, turnTokens: 0 },
      },
      turns: [],
      usage: null,
      cliContext: {
        usedTokens: child ? 8000 : 12000,
        contextWindow: 200000,
        source: 'CLI session log',
        at: '2026-11-19T10:02:00Z',
      },
    });
  });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const context = page.getByRole('region', { name: 'Context' });
  await expect(context).toContainText('12k of 200k · 6% full · CLI');
  await context.getByRole('button', { name: /Open$/ }).click();
  await expect(context).toContainText('not its full retained context');
  await context.getByLabel('Context agent').selectOption('review-run');
  await expect(context).toContainText('8,000 of 200k · 4% full · CLI');
  await expect(context.getByRole('button', { name: 'Compact conversation' })).toBeDisabled();
  await context.getByRole('button', { name: /^Skills 100/ }).click();
  await context.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.locator('pre', { hasText: 'Loaded skill text' })).toBeVisible();
});

test('session CLI controls save role-specific choices, survive navigation, reset and surface refusal', async ({
  authenticatedPage: page,
}) => {
  let overrides: SessionCliOverride[] = [],
    revision = 0,
    refuse = false;
  await page.route('**/api/sessions/*/model-controls', async (route) => {
    const first = route.request().url().includes('/sess-1/');
    if (route.request().method() === 'PUT') {
      if (refuse) return json(route, 409, { error: 'Session model settings changed; refresh before saving' });
      const body = route.request().postDataJSON() as { revision: number; overrides: SessionCliOverride[] };
      expect(body.revision).toBe(revision);
      overrides = body.overrides;
      revision++;
      return json(route, 200, { saved: true, applies: 'next-launch' });
    }
    return json(route, 200, {
      revision: first ? revision : 0,
      overrides: first ? overrides : [],
      runs: [],
      bindings: [
        {
          topic: 'build',
          modelName: 'My Codex',
          adapter: 'Codex CLI',
          model: 'configured-model',
          effort: null,
          efforts: ['low', 'high', 'xhigh'],
          models: [],
        },
      ],
    });
  });
  await page.route('**/api/sessions/*/model-controls/catalog?**', (route) =>
    json(route, 200, { models: [{ id: 'account-model', label: 'Account model' }] }),
  );
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await page.getByText('Models for this session', { exact: true }).click();
  await page.getByLabel('Agent for build My Codex').selectOption('review');
  await page.getByLabel('Model for build My Codex').selectOption('account-model');
  await page.getByLabel('Effort for build My Codex').selectOption('xhigh');
  await page.screenshot({ path: test.info().outputPath('session-model-controls.png') });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => overrides)
    .toEqual([{ modelName: 'My Codex', topic: 'build', role: 'review', model: 'account-model', effort: 'xhigh' }]);
  await selectChatSession(page, 'sess-2');
  await page.getByText('Models for this session', { exact: true }).click();
  await expect(page.getByLabel('Model for build My Codex')).toHaveValue('');
  await selectChatSession(page, 'sess-1');
  await page.getByText('Models for this session · 1 overrides', { exact: true }).click();
  await page.getByLabel('Agent for build My Codex').selectOption('review');
  await expect(page.getByLabel('Model for build My Codex')).toHaveValue('account-model');
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect.poll(() => overrides).toEqual([]);
  refuse = true;
  await page.getByLabel('Model for build My Codex').selectOption('account-model');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Session model settings changed' })).toBeVisible();
});

 test('CLI model picker preserves old choices, allows explicit custom IDs and retries a failed catalog', async ({ authenticatedPage: page }) => {
  let attempts = 0;
  await page.route('**/api/sessions/*/model-controls', route => json(route, 200, {
    revision: 0, overrides: [{ modelName: 'My Codex', topic: 'build', model: 'older-model' }], runs: [],
    bindings: [{ topic: 'build', modelName: 'My Codex', adapter: 'Codex CLI', model: 'configured-model', efforts: [], models: [{ id: 'cached-model', label: 'Cached model' }] }],
  }));
  await page.route('**/api/sessions/*/model-controls/catalog?**', route => {
    attempts++;
    return json(route, 200, attempts === 1 ? { models: [], error: 'Vendor catalog unavailable' } : { models: [{ id: 'new-model', label: 'New account model' }] });
  });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await page.getByText(/Models for this session/).click();
  const picker = page.getByRole('combobox', { name: 'Model for build My Codex', exact: true });
  await expect(picker).toHaveValue('older-model');
  await expect(picker.locator('option[value="older-model"]')).toHaveText('older-model · current selection (not in catalog)');
  await expect(picker.locator('option[value=""]')).toContainText('Use configured default (configured-model)');
  await expect(page.getByRole('textbox', { name: /Custom Model/ })).toHaveCount(0);
  await expect(picker.locator('option[value="cached-model"]')).toHaveText('Cached model');
  await page.getByRole('button', { name: 'Retry catalog' }).click();
  await expect(picker.locator('option[value="new-model"]')).toHaveText('New account model');
  await expect(picker).toHaveValue('older-model');
  await picker.selectOption('__custom__');
  await page.getByRole('textbox', { name: 'Custom Model for build My Codex' }).fill('custom-model');
  await picker.selectOption('new-model');
  await expect(picker).toHaveValue('new-model');
  await expect(page.getByRole('textbox', { name: /Custom Model/ })).toHaveCount(0);
 });
