export type MessageHandler = (message: string) => void;
export type ErrorHandler = (error: Error) => void;
export type CloseHandler = () => void;

/**
 * Transport abstraction for MCP server communication.
 */
export interface MCPTransport {
  connect(): Promise<void>;
  send(message: string, signal?: AbortSignal): void;
  onMessage(handler: MessageHandler): void;
  onError(handler: ErrorHandler): void;
  onClose(handler: CloseHandler): void;
  close(): void;
  /**
   * Close, and resolve once the server process has exited (a transport with
   * no process of its own leaves this out). Used before a restart, so the old
   * process cannot still be writing while the new start is checked.
   */
  closeAndWait?(graceMs?: number): Promise<void>;
}
