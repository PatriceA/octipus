import type { MCPTransport, MessageHandler, ErrorHandler, CloseHandler } from './interface';

export interface StreamableHTTPTransportOptions {
  /** The MCP Streamable HTTP endpoint URL */
  url: string;
  /** Optional headers (e.g. Authorization) */
  headers?: Record<string, string>;
}

/**
 * Streamable HTTP transport for MCP servers (2025-03-26 spec).
 *
 * - Sends JSON-RPC messages via HTTP POST to the endpoint.
 * - Server responds with either:
 *   - application/json (single JSON-RPC response)
 *   - text/event-stream (SSE stream with one or more JSON-RPC messages)
 *
 * This transport is used by n8n and other modern MCP servers.
 */
export class StreamableHTTPTransport implements MCPTransport {
  private options: StreamableHTTPTransportOptions;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private closeHandlers: CloseHandler[] = [];
  private closed = false;
  private sseAbortController: AbortController | null = null;

  constructor(options: StreamableHTTPTransportOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    // Streamable HTTP is stateless — the real handshake happens on the
    // first POST (initialize). Some servers support GET for SSE
    // notifications, but many (like n8n) return 404 for GET.
    // We just mark the transport as ready; the initialize request
    // will fail fast if the endpoint is unreachable.
  }

  /**
   * Listen for server-initiated SSE notifications (optional).
   */
  private async listenSSE(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data) {
              for (const handler of this.messageHandlers) {
                handler(data);
              }
            }
          }
        }
      }
    } catch {
      // SSE stream ended — non-fatal for Streamable HTTP
    }
  }

  /**
   * Send a JSON-RPC message via POST.
   * The response is parsed and dispatched to message handlers.
   */
  send(message: string): void {
    if (this.closed) return;

    this.doPost(message).catch((error) => {
      for (const handler of this.errorHandlers) {
        handler(error as Error);
      }
    });
  }

  private async doPost(message: string): Promise<void> {
    const response = await fetch(this.options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...this.options.headers,
      },
      body: message,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`MCP POST failed (${response.status}): ${body || response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      // SSE response — parse events
      await this.parseSSEResponse(response);
    } else {
      // Direct JSON response
      const text = await response.text();
      if (text.trim()) {
        for (const handler of this.messageHandlers) {
          handler(text);
        }
      }
    }
  }

  private async parseSSEResponse(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data) {
              for (const handler of this.messageHandlers) {
                handler(data);
              }
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data) {
          for (const handler of this.messageHandlers) {
            handler(data);
          }
        }
      }
    } catch (error) {
      for (const handler of this.errorHandlers) {
        handler(error as Error);
      }
    }
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
    this.closed = true;
    this.sseAbortController?.abort();
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}
