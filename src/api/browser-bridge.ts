/**
 * Browser Bridge — service layer for the Chrome extension.
 *
 * Allows agents to send commands to the user's real browser via the extension.
 * Commands are dispatched over WebSocket and responses are returned as promises.
 * The WebSocket endpoint is registered in websocket.ts alongside other WS routes.
 */

import { generateId } from '@/utils/crypto';
import { apiLogger, coreLogger } from '@/utils/logger';

export interface BrowserCommand {
  command: string;
  params: Record<string, unknown>;
}

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: Timer;
}

const DEFAULT_TIMEOUT = 30_000;

class BrowserBridgeService {
  private ws: any = null;
  private pendingCommands = new Map<string, PendingCommand>();
  private _connected = false;
  private extensionInfo: Record<string, unknown> = {};
  private lastTabUpdate: { id: number; url: string; title: string } | null = null;

  get connected(): boolean {
    return this._connected;
  }

  registerConnection(ws: any, info: Record<string, unknown>): void {
    // Close previous connection if any
    if (this.ws) {
      try { this.ws.close(4001, 'Replaced by new connection'); } catch (err) { coreLogger.error({ err }, 'silent failure in browser-bridge'); }
      this.rejectAllPending('Browser extension reconnected');
    }

    this.ws = ws;
    this._connected = true;
    this.extensionInfo = info;
    apiLogger.info({ version: info.version, tabCount: info.tabCount }, 'Browser extension connected');
  }

  handleDisconnect(): void {
    this.ws = null;
    this._connected = false;
    this.rejectAllPending('Browser extension disconnected');
    apiLogger.info('Browser extension disconnected');
  }

  handleResult(id: string, result: unknown, error?: string): void {
    const pending = this.pendingCommands.get(id);
    if (!pending) return;

    this.pendingCommands.delete(id);
    clearTimeout(pending.timer);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }

  handleTabUpdate(tab: { id: number; url: string; title: string }): void {
    this.lastTabUpdate = tab;
  }

  /**
   * Send a command to the browser extension and wait for the result.
   */
  async sendCommand(
    command: string,
    params: Record<string, unknown> = {},
    timeout = DEFAULT_TIMEOUT,
  ): Promise<unknown> {
    if (!this._connected || !this.ws) {
      throw new Error('Browser extension is not connected. Open Chromium with Octipus extension installed.');
    }

    const id = generateId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Browser command "${command}" timed out after ${timeout}ms`));
      }, timeout);

      this.pendingCommands.set(id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify({ type: 'command', id, command, params }));
      } catch (err) {
        this.pendingCommands.delete(id);
        clearTimeout(timer);
        reject(new Error(`Failed to send command: ${(err as Error).message}`));
      }
    });
  }

  getStatus(): { connected: boolean; extensionInfo: Record<string, unknown>; pendingCommands: number } {
    return {
      connected: this._connected,
      extensionInfo: this.extensionInfo,
      pendingCommands: this.pendingCommands.size,
    };
  }

  private rejectAllPending(reason: string): void {
    for (const [_id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingCommands.clear();
  }
}

// Singleton
let instance: BrowserBridgeService | null = null;

export function getBrowserBridge(): BrowserBridgeService {
  if (!instance) {
    instance = new BrowserBridgeService();
  }
  return instance;
}

