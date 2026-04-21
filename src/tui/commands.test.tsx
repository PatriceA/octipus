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

/**
 * Helper: write a string to the stdin in a single chunk, followed by Enter.
 * ink-text-input's useInput handler appends each input delta to the value, so
 * sending the whole buffer as one chunk works and avoids readable-event races.
 */
async function typeAndSubmit(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  stdin.write(text);
  await new Promise((r) => setTimeout(r, 10));
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 10));
}

describe('command handling', () => {
  beforeEach(() => {
    currentMock = null;
  });

  it('sending a chat message invokes sendChat on the gateway', async () => {
    const { stdin } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    typeAndSubmit(stdin, 'hello there');
    await new Promise((r) => setTimeout(r, 30));
    expect(currentMock?.lastChat?.content).toBe('hello there');
  });

  it('slash command /help dispatches via sendCommand', async () => {
    const { stdin } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    typeAndSubmit(stdin, '/help');
    await new Promise((r) => setTimeout(r, 30));
    expect(currentMock?.lastCommand?.name).toBe('help');
  });

  it('slash command /expert Coder passes value arg', async () => {
    const { stdin } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    typeAndSubmit(stdin, '/expert Coder');
    await new Promise((r) => setTimeout(r, 30));
    expect(currentMock?.lastCommand?.name).toBe('expert');
    expect(currentMock?.lastCommand?.args?.value).toBe('Coder');
  });

  it('simulated expert command result updates active expert label', async () => {
    const { stdin, lastFrame } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    typeAndSubmit(stdin, '/expert Coder');
    await new Promise((r) => setTimeout(r, 30));
    currentMock?.simulateCommandResult('expert', 'Switched to expert: Coder.');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() || '';
    expect(frame).toContain('Coder');
  });

  it('/cost command renders a cumulative-usage system line', async () => {
    const { stdin, lastFrame } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    typeAndSubmit(stdin, '/cost');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() || '';
    expect(frame).toContain('Token usage');
  });

  it('empty input does not dispatch anything', async () => {
    const { stdin } = render(<TuiApp />);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(currentMock?.lastChat).toBeNull();
    expect(currentMock?.lastCommand).toBeNull();
  });
});
