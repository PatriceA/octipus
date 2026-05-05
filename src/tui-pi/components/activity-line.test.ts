import { afterEach, describe, expect, test } from 'bun:test';
import { ActivityLine } from './activity-line';

interface TuiStub { requestRender: () => void; renderCalls: number }

function makeStub(): TuiStub {
  const stub = { renderCalls: 0, requestRender: () => { stub.renderCalls += 1; } };
  return stub;
}

const lines: ActivityLine[] = [];

afterEach(() => {
  for (const line of lines) line.dispose();
  lines.length = 0;
});

function makeLine(stub: TuiStub) {
  // biome-ignore lint/suspicious/noExplicitAny: stub fits the small Component subset we use
  const line = new ActivityLine(stub as any);
  lines.push(line);
  return line;
}

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('ActivityLine', () => {
  test('renders nothing when idle', () => {
    const line = makeLine(makeStub());
    expect(line.render(40)).toEqual([]);
  });

  test('renders spinner + name when executing', () => {
    const line = makeLine(makeStub());
    line.setTool({ state: 'executing', name: 'edit' });
    const [text] = line.render(40);
    expect(strip(text)).toContain('edit');
    expect(strip(text).length).toBeGreaterThan(0);
  });

  test('renders ✓ on completed and ✗ on error', () => {
    const a = makeLine(makeStub()); a.setTool({ state: 'completed', name: 'bash' });
    const b = makeLine(makeStub()); b.setTool({ state: 'error',     name: 'edit' });
    expect(strip(a.render(40)[0])).toContain('✓');
    expect(strip(a.render(40)[0])).toContain('bash');
    expect(strip(b.render(40)[0])).toContain('✗');
  });

  test('appends mcp badge when present', () => {
    const line = makeLine(makeStub());
    line.setTool({ state: 'executing', name: 'search', mcpServer: 'serpapi' });
    expect(strip(line.render(120)[0])).toContain('[mcp:serpapi]');
  });

  test('truncates wide output to viewport width', () => {
    const line = makeLine(makeStub());
    line.setTool({ state: 'executing', name: 'a'.repeat(80), preview: 'b'.repeat(80) });
    const [text] = line.render(20);
    expect(strip(text).length).toBeLessThanOrEqual(20);
  });

  test('setTool(null) clears immediately', () => {
    const line = makeLine(makeStub());
    line.setTool({ state: 'executing', name: 'x' });
    line.setTool(null);
    expect(line.render(40)).toEqual([]);
  });

  test('setTool requests a render so the spinner updates', () => {
    const stub = makeStub();
    const line = makeLine(stub);
    line.setTool({ state: 'executing', name: 'edit' });
    expect(stub.renderCalls).toBeGreaterThanOrEqual(1);
  });
});
