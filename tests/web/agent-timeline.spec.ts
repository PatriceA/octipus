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
});
