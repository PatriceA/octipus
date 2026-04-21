/**
 * Test-only helpers for the TUI.
 *
 * Wraps ink-testing-library's `render` with a mocked `GatewayClient` so tests
 * don't need a live backend. The mock exposes the same surface as the real
 * `GatewayClient` (see ./gateway-client.ts) plus a handful of methods to
 * synthesize events + command results from the test side.
 *
 * NOTE: We import the real `GatewayClient` type from the production module
 * only for type-checking; at runtime the test swaps in `MockGatewayClient`
 * by mocking the module via `mock.module` / `bun:test`.
 *
 * ─── Stdin compat shim ──────────────────────────────────────────
 * ink-testing-library v3 ships a Stdin that:
 *   - extends EventEmitter (no ref/unref, no read())
 *   - emits 'data' when you call stdin.write(x)
 *
 * ink v4's App component uses:
 *   stdin.ref(); stdin.addListener('readable', handleReadable)
 *   handleReadable: while ((chunk = stdin.read()) !== null) { emitter.emit('input', chunk) }
 *
 * Bridge: we provide `render` that wraps ink-testing-library's render and
 * post-processes the returned Stdin so write() buffers data + emits 'readable'
 * + read() drains the buffer. This makes `useInput` observe keystrokes.
 */

import { EventEmitter } from 'node:events';
import { cleanup as inkTestingCleanup, render as inkTestingRender } from 'ink-testing-library';
import type { ReactElement } from 'react';
import type { ConnectionStatus, GatewayClientOptions } from './gateway-client';

// Install no-op ref/unref on EventEmitter.prototype (safe — real streams
// override these, and ink-testing-library's Stdin extends EE).
if (typeof (EventEmitter.prototype as any).ref !== 'function') {
  (EventEmitter.prototype as any).ref = function ref() { return this; };
}
if (typeof (EventEmitter.prototype as any).unref !== 'function') {
  (EventEmitter.prototype as any).unref = function unref() { return this; };
}

/**
 * Render an Ink tree with a test-friendly Stdin that supports read() + 'readable'.
 */
export function render(tree: ReactElement) {
  const inst = inkTestingRender(tree);
  const stdin = inst.stdin as any;
  if (stdin && !stdin.__patched) {
    stdin.__patched = true;
    stdin.__buffer = '';
    stdin.read = function read() {
      if (!this.__buffer) return null;
      const out = this.__buffer;
      this.__buffer = '';
      return out;
    };
    const origWrite = stdin.write.bind(stdin);
    stdin.write = function write(data: string) {
      this.__buffer = (this.__buffer || '') + data;
      origWrite(data);
      this.emit('readable');
    };
    if (typeof stdin.ref !== 'function') stdin.ref = () => {};
    if (typeof stdin.unref !== 'function') stdin.unref = () => {};
  }
  return inst;
}

export const cleanup = inkTestingCleanup;

/**
 * Back-compat: some older tests call `applyInkTestingPatch()` directly.
 * It's a no-op now that the patch runs at module load.
 */
export function applyInkTestingPatch(): void {
  /* no-op: patch is applied at module import time */
}

export class MockGatewayClient {
  private options: GatewayClientOptions;
  public status: ConnectionStatus = 'disconnected';

  public lastChat: { sessionId: string; content: string; expertId?: string; projectPath?: string } | null = null;
  public lastCommand: { name: string; args?: Record<string, string> } | null = null;
  public lastPermission: { requestId: string; approved: boolean } | null = null;
  public subscriptions: string[] = [];

  constructor(options: GatewayClientOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.setStatus('connecting');
    queueMicrotask(() => {
      this.setStatus('authenticating');
      queueMicrotask(() => {
        this.setStatus('connected');
      });
    });
  }

  disconnect(): void {
    this.setStatus('disconnected');
  }

  sendChat(sessionId: string, content: string, expertId?: string, projectPath?: string): void {
    this.lastChat = { sessionId, content, expertId, projectPath };
  }

  sendCommand(name: string, args?: Record<string, string>): void {
    this.lastCommand = { name, args };
  }

  respondPermission(requestId: string, approved: boolean): void {
    this.lastPermission = { requestId, approved };
  }

  subscribe(patterns: string[]): void {
    this.subscriptions = patterns;
  }

  ping(): void {
    // no-op
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ── Test-only hooks to synthesize incoming data ──

  simulateEvent(event: unknown): void {
    this.options.onEvent?.(event);
  }

  simulateResponse(text: string): void {
    this.options.onResponse?.(text);
  }

  simulateCommandResult(name: string, result: unknown, error?: string): void {
    this.options.onCommandResult?.(name, result, error);
  }

  simulateError(message: string): void {
    this.options.onError?.(message);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}
