export type MessageHandler = (message: string) => void;
export type ErrorHandler = (error: Error) => void;
export type CloseHandler = () => void;

/**
 * Transport abstraction for MCP server communication.
 */
export interface MCPTransport {
  connect(): Promise<void>;
  send(message: string): void;
  onMessage(handler: MessageHandler): void;
  onError(handler: ErrorHandler): void;
  onClose(handler: CloseHandler): void;
  close(): void;
}
