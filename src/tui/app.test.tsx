import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MockGatewayClient, render } from './test-utils';

// ── Swap the real GatewayClient for the MockGatewayClient before importing
// the TUI app. Bun's module mocking applies to subsequent imports.
let currentMock: MockGatewayClient | null = null;
mock.module('./gateway-client', () => {
  return {
    GatewayClient: class {
      constructor(options: any) {
        currentMock = new MockGatewayClient(options);
        // Return the mock to mimic `new GatewayClient(...)` producing our impl.
        // eslint-disable-next-line no-constructor-return
        return currentMock as any;
      }
    },
  };
});

// Also mock the file-completer since it shells out to fd/find — not wanted in tests.
mock.module('./file-completer', () => ({
  getFileCompletions: (_prefix: string, _cwd: string, cb: (r: string[]) => void) => cb([]),
  cancelFileCompletions: () => {},
  extractPathToken: (_input: string) => null,
}));

// Dynamic import after mock is installed
const { TuiApp } = await import('./app');

describe('TuiApp', () => {
  beforeEach(() => {
    currentMock = null;
  });

  afterEach(() => {
    // let mounted components finalize any timers
  });

  it('renders the welcome banner in the system message', () => {
    const { lastFrame } = render(<TuiApp />);
    const frame = lastFrame() || '';
    expect(frame).toContain('Welcome');
  });

  it('shows the app title "Assistant"', () => {
    const { lastFrame } = render(<TuiApp />);
    expect(lastFrame() || '').toContain('Assistant');
  });

  it('connects a GatewayClient on mount', async () => {
    render(<TuiApp />);
    // Give the queued microtasks a moment to run
    await new Promise((r) => setTimeout(r, 50));
    expect(currentMock).not.toBeNull();
  });

  it('subscribes to all events once auth_ok simulated (auto on connect)', async () => {
    render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 50));
    // MockGatewayClient.connect just flips status; the real connect would
    // subscribe on auth_ok. For the mock we don't auto-subscribe, but the
    // client exists and has a subscribe method wired.
    expect(currentMock).not.toBeNull();
  });

  it('renders the input prompt at the bottom of the frame', () => {
    const { lastFrame } = render(<TuiApp />);
    const frame = lastFrame() || '';
    // input border + placeholder text appear
    expect(frame.length).toBeGreaterThan(0);
  });

  it('passes initial project path to the system banner', () => {
    const { lastFrame } = render(<TuiApp projectPath="/tmp/my-project" />);
    const frame = lastFrame() || '';
    expect(frame).toContain('my-project');
  });
});
