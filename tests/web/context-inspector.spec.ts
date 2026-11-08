import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const section = (category: string, tier: string, label: string, tokens: number, extra: Record<string, unknown> = {}) =>
  ({ category, tier, label, chars: tokens * 4, tokens, ...extra });

const latest = {
  version: 1, measuredAt: '2026-11-08T10:02:14Z', role: 'general', model: 'sonnet', contextWindow: 200_000,
  estimator: 'chars/4', toolCount: 31, registeredToolCount: 214, messageId: 'm-15', textAvailable: true,
  sections: [
    section('guardrails', 'static', 'Security preamble', 520, { text: 'SECURITY RULES:\n1. You have NO admin mode.' }),
    section('role', 'static', 'general role prompt', 2_550, { text: 'You are Octipus, the general-purpose specialist.' }),
    section('delegation', 'static', 'Delegation guide', 2_550, { text: '## DELEGATION' }),
    section('workspace', 'static', 'Repo map', 1_500, { status: 'capped', note: '17 of 23 repos · cap 1,500 tokens', text: 'WORKSPACE SUITE — 23 available repos' }),
    section('tools', 'tools', 'filesystem__edit_file', 820, { text: '{"name":"filesystem__edit_file"}' }),
    section('skills', 'static', 'Selected skills', 1_820, { text: '# vector-search-evaluation' }),
    section('turn', 'volatile', 'Attachments', 6_400, { text: 'benchmark-2025.csv' }),
    section('conversation', 'history', 'Tool results', 45_500, { count: 31, note: 'largest: web_fetch, ~9,800 tokens' }),
    section('conversation', 'history', 'Checkpoint summary', 3_100, { text: '[Conversation checkpoint]\nThe user is choosing a vector store.' }),
  ],
  totals: { tokens: 64_760, prefixTokens: 9_760, turnTokens: 6_400, historyTokens: 48_600 },
};
const turns = [
  { messageId: 'm-14', at: '2026-11-08T10:00:00Z', totals: { tokens: 51_000, prefixTokens: 9_760, turnTokens: 2_000, historyTokens: 39_240 }, byCategory: {} },
  { messageId: 'm-15', at: '2026-11-08T10:02:14Z', totals: latest.totals, byCategory: {} },
];

test('the context inspector shows what the latest request held, by category, with the text the model read', async ({ authenticatedPage: page }) => {
  await page.route('**/api/sessions/sess-1/context', (route) => json(route, 200, {
    latest, turns, usage: { inputTokens: 63_904, cachedInputTokens: 9_400, cacheCreationTokens: 0, at: '2026-11-08T10:02:15Z' },
    limits: { toolTrimTokens: 100_000, summaryTokens: 100_000 },
  }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');

  const panel = page.getByRole('region', { name: 'Context' });
  await expect(panel).toContainText('~64.8k of 200k · 32% full');
  // Where the window starts losing context: one line, since both fall at 100k on a 200k window.
  await expect(panel.getByTestId('context-limit-mark')).toHaveCount(1);
  await expect(panel).toContainText('~100k: older tool output cut and history summarised');
  await panel.getByRole('button', { name: /Open$/ }).click();
  await expect(panel).toContainText('The provider counted 63,904 input tokens for that request, 9,400 from cache.');

  await panel.getByRole('button', { name: /^Workspace \d/ }).click();
  await expect(panel).toContainText('17 of 23 repos · cap 1,500 tokens');
  await expect(panel).toContainText('at cap');
  await panel.getByRole('button', { name: /^Conversation \d/ }).click();
  await expect(panel).toContainText('largest: web_fetch, ~9,800 tokens');
  await panel.getByRole('button', { name: 'Read' }).click();
  const reader = page.locator('pre', { hasText: 'The user is choosing a vector store.' });
  await expect(reader).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(panel.getByRole('figure')).toContainText('Growth by turn');
});

test('after a restart the sizes stay and the text is said to be unavailable, not empty', async ({ authenticatedPage: page }) => {
  await page.route('**/api/sessions/sess-1/context', (route) => json(route, 200, {
    latest: { ...latest, textAvailable: false, contextWindow: undefined }, turns: turns.slice(1), usage: null,
  }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const panel = page.getByRole('region', { name: 'Context' });
  await expect(panel).toContainText('~64.8k tokens');
  await panel.getByRole('button', { name: /Open$/ }).click();
  await expect(panel).toContainText('context window is not known');
  await panel.getByRole('button', { name: /^Guardrails & formatting \d/ }).click();
  await expect(panel.getByRole('button', { name: 'Read' })).toHaveCount(0);
  await expect(panel).toContainText('Text is kept in memory for the latest turn only');
});

test('an unmeasured session says so instead of showing zero', async ({ authenticatedPage: page }) => {
  await page.route('**/api/sessions/sess-1/context', (route) => json(route, 200, { latest: null, turns: [], usage: null }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const panel = page.getByRole('region', { name: 'Context' });
  await expect(panel).toContainText('Not measured yet');
});
