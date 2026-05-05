import { describe, expect, test } from 'bun:test';
import { MCPServerList, type MCPServerListProvider, type MCPServerSummary } from './mcp-server-list';

function makeProvider(servers: MCPServerSummary[], reload?: (id: string) => Promise<void>): MCPServerListProvider {
  return { list: () => servers, reload };
}

function setup(servers: MCPServerSummary[] = [
  { id: 'a', name: 'Alpha', transport: 'stdio', status: 'connected', toolCount: 3 },
  { id: 'b', name: 'Beta',  transport: 'sse',   status: 'error', error: 'timeout' },
]) {
  let closed = false;
  const provider = makeProvider(servers);
  const overlay = new MCPServerList({ provider, onClose: () => { closed = true; } });
  return { overlay, get closed() { return closed; } };
}

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('MCPServerList', () => {
  test('renders header with connected/total counts', () => {
    const { overlay } = setup();
    const text = overlay.render(80).map(strip).join('\n');
    expect(text).toContain('1/2 connected');
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
  });

  test('shows error string for failed connections', () => {
    const { overlay } = setup();
    const text = overlay.render(80).map(strip).join('\n');
    expect(text).toContain('timeout');
  });

  test('Escape closes', () => {
    const ctx = setup();
    ctx.overlay.handleInput('\x1b');
    expect(ctx.closed).toBe(true);
  });

  test('arrow keys move selection', () => {
    const { overlay } = setup();
    expect(overlay.getSelectedIndex()).toBe(0);
    overlay.handleInput('\x1b[B');
    expect(overlay.getSelectedIndex()).toBe(1);
    overlay.handleInput('\x1b[A');
    expect(overlay.getSelectedIndex()).toBe(0);
  });

  test('r calls provider.reload for the highlighted server', async () => {
    const reloaded: string[] = [];
    const provider = makeProvider(
      [{ id: 'a', name: 'A', status: 'disconnected' }],
      async (id) => { reloaded.push(id); },
    );
    const overlay = new MCPServerList({ provider, onClose: () => {} });
    overlay.handleInput('r');
    await new Promise((r) => setTimeout(r, 0));
    expect(reloaded).toEqual(['a']);
  });

  test('placeholder when no servers configured', () => {
    const ctx = setup([]);
    const text = ctx.overlay.render(80).map(strip).join('\n');
    expect(text).toContain('No MCP servers configured');
  });

  test('renders inside a bordered box bounded by viewport width', () => {
    const ctx = setup();
    const lines = ctx.overlay.render(60).map(strip);
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[lines.length - 1].startsWith('└')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});
