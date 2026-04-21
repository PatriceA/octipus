import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MockGatewayClient, render } from './test-utils';

let currentMock: MockGatewayClient | null = null;
mock.module('./gateway-client', () => ({
  GatewayClient: class {
    constructor(options: any) {
      currentMock = new MockGatewayClient(options);
      // eslint-disable-next-line no-constructor-return
      return currentMock as any;
    }
  },
}));

mock.module('./file-completer', () => ({
  getFileCompletions: (_p: string, _c: string, cb: (r: string[]) => void) => cb([]),
  cancelFileCompletions: () => {},
  extractPathToken: () => null,
}));

const { TuiApp } = await import('./app');

async function typeAndSubmit(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  stdin.write(text);
  await new Promise((r) => setTimeout(r, 10));
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 10));
}

describe('chat message flow', () => {
  beforeEach(() => {
    currentMock = null;
  });

  it('user message appears in the frame after submit', async () => {
    const { stdin, lastFrame } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    typeAndSubmit(stdin, 'hello world');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() || '';
    expect(frame).toContain('hello world');
  });

  it('simulated assistant response renders in the chat area', async () => {
    const { lastFrame } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    currentMock?.simulateResponse('Assistant reply here.');
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame() || '').toContain('Assistant reply here.');
  });

  it('agent.spawned event shows a role banner', async () => {
    const { lastFrame } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    currentMock?.simulateEvent({
      type: 'agent.spawned',
      payload: { role: 'coder', model: 'gpt-4o' },
    });
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() || '';
    expect(frame).toContain('Agent spawned');
  });

  it('tool_call event shows the tool name (not raw JSON)', async () => {
    const { lastFrame } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    currentMock?.simulateEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'Bash' } },
    });
    await new Promise((r) => setTimeout(r, 200)); // past the 150ms pending timer
    const frame = lastFrame() || '';
    expect(frame).toContain('Bash');
    expect(frame).not.toContain('{"type"');
  });

  it('permission.request renders a permission prompt', async () => {
    const { lastFrame } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    currentMock?.simulateEvent({
      type: 'permission.request',
      payload: { requestId: 'p-1', toolName: 'Bash', args: { command: 'rm -rf /' } },
    });
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() || '';
    expect(frame).toContain('Permission');
    expect(frame).toContain('Bash');
  });

  it('approving permission fires respondPermission with approved=true', async () => {
    const { stdin } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    currentMock?.simulateEvent({
      type: 'permission.request',
      payload: { requestId: 'req-abc', toolName: 'Bash' },
    });
    await new Promise((r) => setTimeout(r, 30));
    typeAndSubmit(stdin, 'yes');
    await new Promise((r) => setTimeout(r, 30));
    expect(currentMock?.lastPermission?.requestId).toBe('req-abc');
    expect(currentMock?.lastPermission?.approved).toBe(true);
  });
});
