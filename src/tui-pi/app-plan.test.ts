import { afterEach, expect, it, vi } from 'vitest';
import type { Container, TUI } from '@mariozechner/pi-tui';
import { OctipusTuiApp } from './app';
import { StatusBar } from './components/status-bar';
import type { AgentSessionEvent } from './gateway-adapter';

const gateway = vi.hoisted(() => ({ listener: (_event: AgentSessionEvent) => {}, sendCommand: vi.fn() }));
vi.mock('./gateway-adapter', () => ({ GatewayAdapter: class {
  on(listener: (event: AgentSessionEvent) => void) { gateway.listener = listener; }
  sendCommand = gateway.sendCommand;
  disconnect() {}
} }));
vi.mock('@/core/gateway/cli-session', () => ({ readCliSession: () => null }));
afterEach(() => { vi.useRealTimers(); });

it.each(['1/2 steps done', ''])('restores plan status after reconnect when the summary remains %j', async summary => {
  vi.useFakeTimers();
  gateway.sendCommand.mockClear();
  let root!: Container;
  const tui = { addChild: (child: Container) => { root = child; }, setFocus: vi.fn(),
    addInputListener: vi.fn(), requestRender: vi.fn() } as unknown as TUI;
  const app = new OctipusTuiApp(tui, {});
  try {
    const bar = root.children.find(child => child instanceof StatusBar)!;
    const text = () => bar.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    gateway.listener({ kind: 'status', status: 'connected' });
    gateway.listener({ kind: 'command.result', name: 'work-plan-status', result: summary });
    gateway.listener({ kind: 'status', status: 'disconnected' });
    expect(text()).toContain('Unavailable');
    gateway.listener({ kind: 'status', status: 'connected' });
    vi.advanceTimersByTime(4000);
    expect(gateway.sendCommand).toHaveBeenCalledWith('work-plan-status');
    gateway.listener({ kind: 'command.result', name: 'work-plan-status', result: summary });
    expect(text()).not.toContain('Unavailable');
    if (summary) expect(text()).toContain(summary);
    else expect(bar.render(120)).toHaveLength(1);
  } finally { await app.stop(); }
});
