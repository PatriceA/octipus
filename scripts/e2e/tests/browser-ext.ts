import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testBrowserExt(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mBrowser Extension Tool\x1b[0m');

  await runner.test('GET /tools/browser-ext returns browser-ext tool with v2 tools', async () => {
    const { status, data } = await client.request<{ id: string; version: string; tools: Array<{ name: string }> }>('GET', '/tools/browser-ext');
    assertStatus(status, 200);
    assert(data.id === 'browser-ext', `Expected id 'browser-ext', got ${data.id}`);
    assert(Array.isArray(data.tools), 'tools should be an array');
    // v2 should have 20+ tools (original + new capabilities)
    assert(data.tools.length >= 20, `Expected at least 20 tools in browser-ext, got ${data.tools.length}`);

    const toolNames = data.tools.map(t => t.name);
    // Verify core tools
    for (const name of ['navigate', 'click', 'fill', 'screenshot', 'extract_content', 'evaluate']) {
      assert(toolNames.includes(name), `Missing core tool: ${name}`);
    }
    // Verify v2 tools (tab management, interactions, monitoring)
    for (const name of ['new_tab', 'close_tab', 'select_tab', 'hover', 'select', 'press_key', 'scroll', 'drag', 'wait_for', 'highlight', 'get_console', 'get_network', 'handle_dialog']) {
      assert(toolNames.includes(name), `Missing v2 tool: ${name}`);
    }
  });

  await runner.test('GET /tools/browser returns Playwright browser tool', async () => {
    const { status, data } = await client.request<{ id: string; description: string }>('GET', '/tools/browser');
    assertStatus(status, 200);
    assert(data.id === 'browser', `Expected id 'browser', got ${data.id}`);
    // Playwright tools are registered dynamically (not in manifest), so just verify the tool exists
    assert(data.description.toLowerCase().includes('browser') || data.description.toLowerCase().includes('playwright'),
      `Expected browser-related description, got: ${data.description}`);
  });
}
