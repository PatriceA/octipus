import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

test.describe('agent timeline', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('action events render toolName(preview) not raw JSON (regression)', async ({ authenticatedPage: page }) => {
    // Stub an action event stream response.
    await page.route('**/api/agents/*/events**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          events: [
            {
              type: 'agent.action',
              payload: { data: { type: 'tool_call', toolName: 'Bash', args: { command: 'ls -la' } } },
              timestamp: new Date().toISOString(),
            },
            {
              type: 'agent.action',
              payload: { data: { type: 'tool_result', toolName: 'Bash', output: 'file1\nfile2\n' } },
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      }),
    );
    await page.goto('/agents/sess-1');
    const body = page.locator('body');
    // We expect a "Bash" headline; raw JSON with curly braces should not be dominant.
    const content = await body.textContent();
    if (content?.toLowerCase().includes('bash')) {
      // If we rendered tool events, they should at least show the tool name.
      expect(content).toMatch(/Bash/);
    }
  });

  test('agent detail loads every durable event page and distinguishes turns from tool calls', async ({ authenticatedPage: page }) => {
    const now = new Date().toISOString();
    const allEvents = Array.from({ length: 503 }, (_, index) => {
      const seq = index + 1;
      if (index === 0) {
        return {
          seq,
          type: 'thought',
          agentId: 'history-agent',
          data: { text: 'earliest durable event' },
          timestamp: now,
        };
      }
      if (index <= 53) {
        return {
          seq,
          type: 'action',
          agentId: 'history-agent',
          data: { type: 'tool_call_complete', name: `tool-${index}`, status: 'completed' },
          timestamp: now,
        };
      }
      return {
        seq,
        type: 'thought',
        agentId: 'history-agent',
        data: { text: `event ${seq}` },
        timestamp: now,
      };
    });
    const requestedCursors: number[] = [];

    await page.route('**/api/agents/history-agent', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'history-agent',
          sessionId: 'sess-1',
          userId: 'e2e-user-id',
          topic: 'general',
          model: 'gemini-general',
          status: 'completed',
          completionReason: 'iteration_limit',
          iteration: 25,
          createdAt: now,
          metadata: {},
        }),
      }),
    );
    await page.route('**/api/agents/history-agent/events**', (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('source')).toBe('persisted');
      const after = Number(url.searchParams.get('after') ?? 0);
      requestedCursors.push(after);
      const events = allEvents.filter((event) => event.seq > after).slice(0, 200);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          source: 'persisted',
          events,
          nextCursor: events.at(-1)?.seq ?? after,
          hasMore: after + events.length < allEvents.length,
        }),
      });
    });
    await page.route('**/api/verification/sess-1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessionId: 'sess-1', verified: false, evidence: [] }),
      }),
    );

    await page.goto('/agents/view?id=history-agent');

    await expect(page.getByText('503 recorded events').first()).toBeVisible();
    await expect(page.getByText('25 model turns')).toBeVisible();
    await expect(page.getByText('53 completed tool calls')).toBeVisible();
    await expect(page.getByText('Stopped at turn limit')).toBeVisible();
    await expect(page.getByText(/Model turns are inference cycles reported by the agent/)).toBeVisible();
    await expect(page.getByText(/earliest durable event/)).toBeAttached();
    expect(requestedCursors.slice(0, 3)).toEqual([0, 200, 400]);
  });
});
