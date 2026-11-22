import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

/** The offer to distil a finished run into a skill, against stubbed `/api/sessions/:id/distill-nudge` routes. */

const OFFER = { nudge: { messageId: '11111111-1111-4111-8111-111111111111', offeredAt: '2026-11-20T10:00:00Z' } };

function stubOffer(page: import('@playwright/test').Page, outcome: (decision: string) => { status: number; body: unknown }) {
  const decisions: string[] = [];
  void page.route('**/api/sessions/sess-1/distill-nudge**', (route) => {
    if (route.request().method() === 'POST') {
      const { decision } = route.request().postDataJSON() as { decision: string };
      decisions.push(decision);
      const answer = outcome(decision);
      return json(route, answer.status, answer.body);
    }
    return json(route, 200, OFFER);
  });
  return decisions;
}

test('accepting the offer files a proposal and links to it', async ({ authenticatedPage: page }) => {
  const decisions = stubOffer(page, () => ({ status: 200, body: { state: 'accepted', distilled: true, proposalId: 'p1', status: 'pending',
    message: 'Filed for review on Skills → Proposals.' } }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const offer = page.getByTestId('distill-nudge');
  await expect(offer).toContainText('Save how it was done as a skill?');
  await offer.getByRole('button', { name: 'Distil into a skill' }).click();
  await expect.poll(() => decisions).toEqual(['accept']);
  await expect(offer).toContainText('Filed for review on Skills → Proposals.');
  await expect(offer.getByRole('link', { name: 'Review proposal' })).toHaveAttribute('href', '/skills/proposals');
});

test('not now and don\'t ask again close the offer', async ({ authenticatedPage: page }) => {
  const decisions = stubOffer(page, (decision) => ({ status: 200, body: { state: 'dismissed', message: 'Not distilled.', ...(decision === 'never' ? { optedOut: true } : {}) } }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const offer = page.getByTestId('distill-nudge');
  await offer.getByRole('button', { name: 'Not now' }).click();
  await expect.poll(() => decisions).toEqual(['dismiss']);
  await expect(offer).toHaveCount(0);
});

test('a failed distillation says why and keeps the offer', async ({ authenticatedPage: page }) => {
  stubOffer(page, () => ({ status: 502, body: { error: 'No model is bound to the background lane — bind one on the Topics page.', code: 'failed' } }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const offer = page.getByTestId('distill-nudge');
  await offer.getByRole('button', { name: 'Distil into a skill' }).click();
  await expect(offer.getByRole('alert')).toContainText('No model is bound');
  await expect(offer.getByRole('button', { name: 'Distil into a skill' })).toBeEnabled();
});
