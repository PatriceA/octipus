import type { CloseHandler, ErrorHandler, MCPTransport, MessageHandler } from './interface';

export interface SSETransportOptions {
  /** SSE endpoint URL (for receiving server events) */
  sseUrl: string;
  /** POST endpoint URL (for sending messages to server) */
  postUrl: string;
  /** Optional headers (e.g. Authorization) */
  headers?: Record<string, string>;
}

/**
 * SSE-based transport for remote MCP servers.
 * Receives messages via Server-Sent Events, sends via HTTP POST.
 */
export class SSETransport implements MCPTransport {
  private options: SSETransportOptions;
  private abortController: AbortController | null = null;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private closeHandlers: CloseHandler[] = [];

  constructor(options: SSETransportOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.abortController = new AbortController();

    // Start SSE listener
    this.startSSEListener();
  }

  private async startSSEListener(): Promise<void> {
    try {
      const response = await fetch(this.options.sseUrl, {
        headers: this.options.headers,
        signal: this.abortController!.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body for SSE stream');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          for (const handler of this.closeHandlers) handler();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data.trim()) {
              for (const handler of this.messageHandlers) {
                handler(data);
              }
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        for (const handler of this.errorHandlers) {
          handler(error as Error);
        }
      }
    }
  }

  send(message: string): void {
    fetch(this.options.postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.options.headers,
      },
      body: message,
    }).catch((error) => {
      for (const handler of this.errorHandlers) {
        handler(error as Error);
      }
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: CloseHandler): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
