import { EventEmitter } from 'events';
import { coreLogger } from '@/utils/logger';

// MCP Protocol Types
export interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: MCPError;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

export interface MCPCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

// MCP Error Codes
export const MCPErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  UnknownError: -32001,
} as const;

export class MCPProtocol extends EventEmitter {
  private messageId = 0;
  private pendingRequests: Map<string | number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();
  private requestTimeout = 30000;

  /**
   * Generate a unique message ID
   */
  generateId(): number {
    return ++this.messageId;
  }

  /**
   * Create a request message
   */
  createRequest(method: string, params?: unknown): MCPMessage {
    return {
      jsonrpc: '2.0',
      id: this.generateId(),
      method,
      params,
    };
  }

  /**
   * Create a notification message (no response expected)
   */
  createNotification(method: string, params?: unknown): MCPMessage {
    return {
      jsonrpc: '2.0',
      method,
      params,
    };
  }

  /**
   * Create a response message
   */
  createResponse(id: string | number, result: unknown): MCPMessage {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  /**
   * Create an error response
   */
  createErrorResponse(id: string | number, code: number, message: string, data?: unknown): MCPMessage {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
  }

  /**
   * Parse an incoming message
   */
  parseMessage(data: string): MCPMessage {
    try {
      const message = JSON.parse(data);

      if (message.jsonrpc !== '2.0') {
        throw new Error('Invalid JSON-RPC version');
      }

      return message as MCPMessage;
    } catch (error) {
      throw new Error(`Failed to parse MCP message: ${(error as Error).message}`);
    }
  }

  /**
   * Handle an incoming message
   */
  handleMessage(message: MCPMessage): void {
    // Check if this is a response to a pending request
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pendingRequests.get(message.id);

      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(`MCP Error ${message.error.code}: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    // Check if this is a request or notification
    if (message.method) {
      this.emit('request', message);
    }
  }

  /**
   * Send a request and wait for response
   */
  async sendRequest(
    send: (message: string) => void,
    method: string,
    params?: unknown
  ): Promise<unknown> {
    const request = this.createRequest(method, params);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id!);
        reject(new Error(`MCP request timeout: ${method}`));
      }, this.requestTimeout);

      this.pendingRequests.set(request.id!, { resolve, reject, timeout });

      try {
        send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(request.id!);
        reject(error);
      }
    });
  }

  /**
   * Send a notification (no response expected)
   */
  sendNotification(send: (message: string) => void, method: string, params?: unknown): void {
    const notification = this.createNotification(method, params);
    send(JSON.stringify(notification));
  }

  /**
   * Clean up pending requests
   */
  cleanup(): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('MCP connection closed'));
    }
    this.pendingRequests.clear();
  }

  /**
   * Set request timeout
   */
  setRequestTimeout(ms: number): void {
    this.requestTimeout = ms;
  }
}

// Standard MCP methods
export const MCPMethods = {
  // Lifecycle
  Initialize: 'initialize',
  Initialized: 'notifications/initialized',
  Shutdown: 'shutdown',

  // Tools
  ListTools: 'tools/list',
  CallTool: 'tools/call',

  // Resources
  ListResources: 'resources/list',
  ReadResource: 'resources/read',
  Subscribe: 'resources/subscribe',
  Unsubscribe: 'resources/unsubscribe',

  // Prompts
  ListPrompts: 'prompts/list',
  GetPrompt: 'prompts/get',

  // Logging
  SetLogLevel: 'logging/setLevel',

  // Notifications
  ResourceUpdated: 'notifications/resources/updated',
  ToolListChanged: 'notifications/tools/list_changed',
  PromptListChanged: 'notifications/prompts/list_changed',
  LogMessage: 'notifications/message',
} as const;
