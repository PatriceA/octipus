import { afterEach, expect, it, vi } from 'vitest';
import type { Container, TUI } from '@/tui-kit';
import { OctipusTuiApp } from './app';
import { StatusBar } from './components/status-bar';
import type { AgentSessionEvent } from './gateway-adapter';

const gateway = vi.hoisted(() => ({ listener: (_event: AgentSessionEvent) => {}, sendCommand: vi.fn((..._args: unknown[]) => true) }));
vi.mock('./gateway-adapter', () => ({ GatewayAdapter: class {
  on(listener: (event: AgentSessionEvent) => void) { gateway.listener = listener; }
  sendCommand = gateway.sendCommand;
  isConnected() { return true; }
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

it('automatic plan refresh repaints without duplicating transcript', async () => {
  let root!: Container;
  const requestRender = vi.fn();
  const tui = { addChild: (c: Container) => { root = c; }, setFocus: vi.fn(), addInputListener: vi.fn(), requestRender } as unknown as TUI;
  const app = new OctipusTuiApp(tui, {});
  try {
    gateway.listener({ kind: 'command.result', name: 'work-plan', result: 'Plan title\n[>] First' });
    gateway.listener({ kind: 'command.result', name: 'work-plan-status', result: '1/3 done' });
    requestRender.mockClear();
    gateway.listener({ kind: 'command.result', name: 'work-plan', result: 'Plan title\n[>] Second' });
    expect(requestRender).toHaveBeenCalled();
    const messages = root.children[0];
    const transcript = messages.render(120).join('\n');
    expect(transcript.match(/Plan title/g)).toHaveLength(1);
    const bar = root.children.find(c => c instanceof StatusBar)!;
    expect(bar.render(120).join('\n')).toContain('Second');
  } finally { await app.stop(); }
});


it('opens a newly published plan automatically without flooding the transcript', async () => {
  let root!: Container;
  gateway.sendCommand.mockClear();
  const tui = { addChild: (c: Container) => { root = c; }, setFocus: vi.fn(), addInputListener: vi.fn(), requestRender: vi.fn() } as unknown as TUI;
  const app = new OctipusTuiApp(tui, {});
  try {
    const bar = root.children.find(c => c instanceof StatusBar)!;
    gateway.listener({ kind: 'command.result', name: 'work-plan-status', result: 'Backend profiles · v2 · 0/5 steps done' });
    expect(gateway.sendCommand).toHaveBeenCalledWith('work-plan');
    expect(bar.isPlanExpanded()).toBe(true);
    gateway.listener({ kind: 'command.result', name: 'work-plan', result: 'Backend profiles\n[ ] Implement profile storage\n[ ] Isolate network clients' });
    expect(bar.render(120).join('\n')).toContain('Implement profile storage');
    expect(root.children[0].render(120).join('\n')).not.toContain('Implement profile storage');
    bar.setPlanDetails(null);
    gateway.sendCommand.mockClear();
    gateway.listener({ kind: 'command.result', name: 'work-plan-status', result: 'Backend profiles · v3 · 0/5 steps done' });
    expect(bar.isPlanExpanded()).toBe(false);
    expect(gateway.sendCommand).not.toHaveBeenCalledWith('work-plan');
  } finally { await app.stop(); }
});

it('keeps a collapsed plan closed when an automatic detail request fails', async () => {
  let root!: Container;
  const tui = { addChild: (c: Container) => { root = c; }, setFocus: vi.fn(), addInputListener: vi.fn(), requestRender: vi.fn() } as unknown as TUI;
  const app = new OctipusTuiApp(tui, {});
  try {
    const bar = root.children.find(c => c instanceof StatusBar)!;
    gateway.listener({ kind: 'command.result', name: 'work-plan-status', result: 'Proposed · Profiles · revision 1 · 0/2 steps done' });
    expect(bar.isPlanExpanded()).toBe(true);
    bar.setPlanDetails(null);
    gateway.listener({ kind: 'command.result', name: 'work-plan', result: null, error: 'Connection lost' });
    expect(bar.isPlanExpanded()).toBe(false);
  } finally { await app.stop(); }
});

it('fetches the plan status on connect and when the gateway says the plan changed, never on a timer', async () => {
  vi.useFakeTimers();
  gateway.sendCommand.mockClear();
  let root!: Container;
  const tui = { addChild: (child: Container) => { root = child; }, setFocus: vi.fn(), addInputListener: vi.fn(), requestRender: vi.fn() } as unknown as TUI;
  const app = new OctipusTuiApp(tui, {});
  try {
    const statusFetches = () => gateway.sendCommand.mock.calls.filter(call => call[0] === 'work-plan-status').length;
    gateway.listener({ kind: 'status', status: 'connected' });
    expect(statusFetches()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(statusFetches()).toBe(1);
    gateway.listener({ kind: 'plan.updated', revision: 3 });
    expect(statusFetches()).toBe(2);
    gateway.listener({ kind: 'command.result', name: 'work-plan-status', result: '2/3 steps done · Verify' });
    const bar = root.children.find(child => child instanceof StatusBar)!;
    expect(bar.render(120).join('\n')).toContain('2/3 steps done');
  } finally { await app.stop(); }
});
