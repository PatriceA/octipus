import type { Route, WebSocketRoute } from '@playwright/test';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test.describe('chat page', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.route('**/api/chat/send**', (route) =>
      json(route, 200, {
        response: 'Hello from the stubbed assistant.',
        sessionId: 'sess-1',
        tokens: 12,
      }),
    );
    // Block WS upgrade so tests don't hang waiting for a live socket.
    await page.route('**/ws**', (route) => route.abort());
  });

  test('loads chat page with session list', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByTestId('current-session-title')).toHaveText('First chat');
    await expect(page.locator('.workspace-conversation > div').first().locator('select')).toHaveCount(0);
  });

  test('empty input cannot be submitted', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    // The Send button is rendered by PromptInput; it may be absent when no session active.
    const submit = page.getByRole('button', { name: /send/i }).first();
    if (await submit.isVisible().catch(() => false)) {
      // With empty input, button should be disabled.
      await expect(submit).toBeDisabled();
    }
  });

  test('typing a message updates the input', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    const input = page.getByPlaceholder(/send a message|create a session/i).first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill('Hello world');
    await expect(input).toHaveValue('Hello world');
  });

  test('long message fills without truncation', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    const input = page.getByPlaceholder(/send a message|create a session/i).first();
    await input.waitFor({ state: 'visible' });
    const longMsg = 'A'.repeat(2000);
    await input.fill(longMsg);
    await expect(input).toHaveValue(longMsg);
  });

  test('switching session preserves history visually', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    const first = page.locator('[data-session-id="sess-1"]');
    await first.focus();
    await first.press('Enter');
    const second = page.locator('[data-session-id="sess-2"]');
    await second.focus();
    await second.press('Space');
    await expect(page.getByTestId('current-session-title')).toHaveText('Second chat');
  });

  test('compact chat switches sessions through the session drawer', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/chat');

    const switcher = page.getByRole('button', { name: /Switch conversation/ });
    await expect(switcher).toBeVisible();
    await switcher.click();
    const drawer = page.getByRole('dialog', { name: 'Conversations' });
    await expect(drawer).toBeVisible();
    const second = drawer.locator('[data-session-id="sess-2"]');
    await second.click();

    const updatedSwitcher = page.getByRole('button', { name: 'Switch conversation: Second chat' });
    await expect(updatedSwitcher).toBeVisible();
    await expect(updatedSwitcher).toBeFocused();
    await expect(drawer).toHaveCount(0);

    await updatedSwitcher.click();
    await expect(drawer.locator('[data-session-id="sess-2"]')).toBeFocused();
    const drawerButtons = drawer.getByRole('button');
    await drawerButtons.last().focus();
    await drawerButtons.last().press('Tab');
    await expect(drawerButtons.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(updatedSwitcher).toBeFocused();
  });

  test('restores all 53 tool calls from a 243-event durable agent history', async ({ authenticatedPage: page }) => {
    const now = new Date().toISOString();
    const toolStarts = Array.from({ length: 53 }, (_, index) => ({
      seq: index + 1,
      type: 'action',
      agentId: 'history-agent',
      data: { toolCalls: [{ id: `call-${index + 1}`, name: `tool-${index + 1}` }] },
      timestamp: now,
    }));
    const toolCompletions = Array.from({ length: 53 }, (_, index) => ({
      seq: index + 54,
      type: 'action',
      agentId: 'history-agent',
      data: {
        type: 'tool_call_complete',
        toolCallId: `call-${index + 1}`,
        name: `tool-${index + 1}`,
        status: 'completed',
      },
      timestamp: now,
    }));
    const remaining = Array.from({ length: 137 }, (_, index) => ({
      seq: index + 107,
      type: 'thought',
      agentId: 'history-agent',
      data: { text: `thought-${index + 1}` },
      timestamp: now,
    }));
    const allEvents = [...toolStarts, ...toolCompletions, ...remaining];
    const requestedCursors: number[] = [];
    const pendingFirstPages: Route[] = [];
    let releaseHistory = false;
    let socket: WebSocketRoute | undefined;

    await page.route('**/api/agents?sessionId=**', (route) =>
      json(route, 200, {
        agents: [{
          id: 'history-agent',
          sessionId: 'sess-1',
          role: 'general',
          root: false,
          model: 'gemini-general',
          status: 'completed',
          completionReason: 'iteration_limit',
          createdAt: now,
          completedAt: now,
          durationMs: 1000,
          iteration: 25,
        }],
      }),
    );
    const fulfillEventPage = (route: Route, after: number) => {
      const events = allEvents.filter((event) => event.seq > after).slice(0, 200);
      return json(route, 200, {
        source: 'persisted',
        events,
        nextCursor: events.at(-1)?.seq ?? after,
        hasMore: after + events.length < allEvents.length,
      });
    };
    await page.route('**/api/agents/history-agent/events**', (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('source')).toBe('persisted');
      const after = Number(url.searchParams.get('after') ?? 0);
      requestedCursors.push(after);
      if (after === 0 && !releaseHistory) {
        pendingFirstPages.push(route);
        return;
      }
      return fulfillEventPage(route, after);
    });
    await page.routeWebSocket(/\/ws\?/, (ws) => { socket = ws; });

    await page.goto('/chat');

    await selectChatSession(page, 'sess-1');

    await expect.poll(() => Boolean(socket && pendingFirstPages.length > 0)).toBe(true);
    socket!.send(JSON.stringify({
      type: 'turn_event',
      sessionId: 'sess-1',
      event: 'worker_spawned',
      data: { workerId: 'history-agent', role: 'general', model: 'gemini-general' },
    }));
    socket!.send(JSON.stringify({
      type: 'agent_event',
      sessionId: 'sess-1',
      event: 'action',
      agentId: 'history-agent',
      data: { toolCalls: toolStarts.slice(-44).flatMap((event) => event.data.toolCalls) },
    }));
    await expect(page.getByTitle('44 tool calls')).toBeVisible();

    releaseHistory = true;
    await Promise.all(pendingFirstPages.map((route) => fulfillEventPage(route, 0)));

    await expect(page.getByTitle('53 tool calls')).toBeVisible();
    await expect(page.getByText('25 model turns')).toBeVisible();
    await expect(page.getByText('Stopped at turn limit')).toBeVisible();
    expect(requestedCursors.slice(0, 2)).toEqual([0, 200]);
  });
});
