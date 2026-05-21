import type { MCPTransport } from '@/mcp/transports/interface';

type MessageHandler = (data: string) => void;
type ErrorHandler = (err: Error) => void;
type CloseHandler = () => void;

/**
 * Stateless HTTP transport for remote MCP servers requiring OAuth 2.1.
 * `getToken` is called before every POST — callers should handle refresh internally.
 */
export class OAuthHTTPTransport implements MCPTransport {
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private closeHandlers: CloseHandler[] = [];
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string>,
  ) {}

  async connect(): Promise<void> {
    // Stateless — readiness is confirmed by the first successful POST.
  }

  send(message: string): void {
    if (this.closed) return;
    this.doPost(message).catch((err) => {
      for (const h of this.errorHandlers) h(err as Error);
    });
  }

  private async doPost(message: string): Promise<void> {
    const token = await this.getToken();

    const request = new Request(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: message,
    });

    let response: Response;
    try {
      response = await fetch(request);
    } catch (err) {
      throw new Error(`MCP POST to ${this.url} failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`MCP POST to ${this.url} failed (${response.status}): ${body || response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      await this.parseSSEResponse(response);
    } else {
      const text = await response.text();
      if (text.trim()) {
        for (const h of this.messageHandlers) h(text);
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
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data) for (const h of this.messageHandlers) h(data);
          }
        }
      }
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data) for (const h of this.messageHandlers) h(data);
      }
    } catch (err) {
      for (const h of this.errorHandlers) h(err as Error);
    }
  }

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler); }
  onError(handler: ErrorHandler): void { this.errorHandlers.push(handler); }
  onClose(handler: CloseHandler): void { this.closeHandlers.push(handler); }

  close(): void {
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
}
