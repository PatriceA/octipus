import { EventEmitter } from 'events';
import { getConfig } from '@/config';
import { getSettingsService } from '@/config/settings-service';
import type { ToolHandler } from '@/core/agent-worker';
import type { MCPServer, MCPTool } from '@/core/types';
import { coreLogger } from '@/utils/logger';
import { getMcpCircuitBreaker } from './circuit-breaker';
import { type MCPCapabilities, MCPMethods, type MCPPrompt, MCPProtocol, type MCPResource, type MCPToolDefinition } from './protocol';
import type { MCPTransport } from './transports/interface';
import { SSETransport } from './transports/sse';
import { StdioTransport } from './transports/stdio';
import { StreamableHTTPTransport } from './transports/streamable-http';

export interface MCPServerConnection {
  id: string;
  server: MCPServer;
  transport: MCPTransport;
  protocol: MCPProtocol;
  capabilities: MCPCapabilities;
  tools: MCPToolDefinition[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
}

export class MCPBridge extends EventEmitter {
  private connections: Map<string, MCPServerConnection> = new Map();
  private serverConfigs: MCPServer[] = [];
  // Auto-reconnect state for unexpected transport closes (server crash / OS kill).
  private reconnectAttempts: Map<string, number> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private intentionalDisconnects: Set<string> = new Set();
  private static readonly MAX_RECONNECT_ATTEMPTS = 6;
  private static readonly RECONNECT_BASE_MS = 1_000;
  private static readonly RECONNECT_MAX_MS = 30_000;

  /**
   * Load MCP server configurations from JSON file (if configured) or database.
   */
  async loadConfig(): Promise<void> {
    const config = getConfig();

    // Prefer file-based config if explicitly configured
    if (config.mcp.serversConfigPath) {
      try {
        const file = Bun.file(config.mcp.serversConfigPath);
        const content = await file.json();
        this.serverConfigs = content.servers || [];
        coreLogger.info({ count: this.serverConfigs.length, source: 'file' }, 'MCP server configs loaded');
        return;
      } catch (error) {
        coreLogger.warn({ error }, 'Failed to load MCP servers config from file');
      }
    }

    // Fall back to database storage
    try {
      const settingsService = getSettingsService();
      const stored = await settingsService.get('mcp.servers');
      if (stored && Array.isArray(stored)) {
        this.serverConfigs = stored as MCPServer[];
        coreLogger.info({ count: this.serverConfigs.length, source: 'database' }, 'MCP server configs loaded');
      } else {
        coreLogger.debug('No MCP server configs found in database');
      }
    } catch (error) {
      coreLogger.warn({ error }, 'Failed to load MCP servers config from database');
    }
  }

  /**
   * Create the appropriate transport based on server config
   */
  private createTransport(server: MCPServer): MCPTransport {
    if (server.transport === 'sse' && server.sseUrl && server.postUrl) {
      return new SSETransport({
        sseUrl: server.sseUrl,
        postUrl: server.postUrl,
        headers: server.headers,
      });
    }

    if (server.transport === 'streamable-http' && server.sseUrl) {
      return new StreamableHTTPTransport({
        url: server.sseUrl, // sseUrl field reused for the HTTP endpoint URL
        headers: server.headers,
      });
    }

    return new StdioTransport({
      command: server.command,
      args: server.args,
      env: server.env,
    });
  }

  /**
   * Connect to an MCP server
   */
  async connect(server: MCPServer): Promise<MCPServerConnection> {
    if (this.connections.has(server.id)) {
      return this.connections.get(server.id)!;
    }

    coreLogger.info({ serverId: server.id, transport: server.transport || 'stdio' }, 'Connecting to MCP server');

    // A fresh connect clears any intentional-disconnect flag / pending reconnect
    // so future unexpected closes on this server trigger auto-reconnect again.
    this.intentionalDisconnects.delete(server.id);
    this.clearReconnectTimer(server.id);

    const protocol = new MCPProtocol();
    const transport = this.createTransport(server);

    const connection: MCPServerConnection = {
      id: server.id,
      server,
      transport,
      protocol,
      capabilities: {},
      tools: [],
      resources: [],
      prompts: [],
      status: 'connecting',
    };

    try {
      await transport.connect();

      // Wire transport messages to protocol
      transport.onMessage((line) => {
        try {
          const message = protocol.parseMessage(line);
          protocol.handleMessage(message);
        } catch (error) {
          coreLogger.error({ error, line }, 'Failed to parse MCP message');
        }
      });

      transport.onError((error) => {
        coreLogger.error({ err: error, serverId: server.id, errorMessage: error.message }, 'MCP transport error');
        connection.status = 'error';
        connection.error = error.message;
        this.emit('error', server.id, error);
      });

      transport.onClose(() => {
        coreLogger.info({ serverId: server.id }, 'MCP transport closed');
        connection.status = 'disconnected';
        this.emit('disconnected', server.id);
        // Unexpected close (not via disconnect()) → try to recover the server.
        if (!this.intentionalDisconnects.has(server.id)) {
          this.scheduleReconnect(server);
        }
      });

      // Send function via transport
      const send = (message: string) => {
        transport.send(message);
      };

      // Initialize the connection
      const initResult = await protocol.sendRequest(send, MCPMethods.Initialize, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        clientInfo: {
          name: 'assistant',
          version: '1.0.0',
        },
      }) as { capabilities: MCPCapabilities };

      connection.capabilities = initResult.capabilities || {};

      // Send initialized notification
      protocol.sendNotification(send, MCPMethods.Initialized);

      // Fetch available tools
      if (connection.capabilities.tools) {
        const toolsResult = await protocol.sendRequest(send, MCPMethods.ListTools) as { tools: MCPToolDefinition[] };
        connection.tools = toolsResult.tools || [];
      }

      // Fetch available resources
      if (connection.capabilities.resources) {
        const resourcesResult = await protocol.sendRequest(send, MCPMethods.ListResources) as { resources: MCPResource[] };
        connection.resources = resourcesResult.resources || [];
      }

      // Fetch available prompts
      if (connection.capabilities.prompts) {
        const promptsResult = await protocol.sendRequest(send, MCPMethods.ListPrompts) as { prompts: MCPPrompt[] };
        connection.prompts = promptsResult.prompts || [];
      }

      connection.status = 'connected';
      this.reconnectAttempts.delete(server.id);
      this.connections.set(server.id, connection);

      coreLogger.info({
        serverId: server.id,
        tools: connection.tools.length,
        resources: connection.resources.length,
        prompts: connection.prompts.length,
      }, 'MCP server connected');

      this.emit('connected', server.id);

      return connection;
    } catch (error) {
      connection.status = 'error';
      connection.error = (error as Error).message;
      coreLogger.error({ err: error, serverId: server.id, errorMessage: (error as Error).message }, 'Failed to connect to MCP server');
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverId: string): Promise<void> {
    // Mark intentional and cancel any pending reconnect BEFORE closing, so the
    // transport's onClose handler doesn't schedule a reconnect for a server we
    // are deliberately shutting down.
    this.intentionalDisconnects.add(serverId);
    this.clearReconnectTimer(serverId);
    this.reconnectAttempts.delete(serverId);

    const connection = this.connections.get(serverId);
    if (!connection) return;

    try {
      const send = (message: string) => {
        connection.transport.send(message);
      };

      await connection.protocol.sendRequest(send, MCPMethods.Shutdown).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in bridge'));
    } catch {
      // Ignore errors during shutdown
    }

    connection.transport.close();
    connection.protocol.cleanup();
    this.connections.delete(serverId);

    coreLogger.info({ serverId }, 'MCP server disconnected');
  }

  private clearReconnectTimer(serverId: string): void {
    const timer = this.reconnectTimers.get(serverId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(serverId);
    }
  }

  /**
   * Schedule an exponential-backoff reconnect after an unexpected transport
   * close (crash / OS kill). Bounded by MAX_RECONNECT_ATTEMPTS so a
   * permanently-dead server stops retrying instead of spinning forever.
   */
  private scheduleReconnect(server: MCPServer): void {
    const attempts = this.reconnectAttempts.get(server.id) ?? 0;
    if (attempts >= MCPBridge.MAX_RECONNECT_ATTEMPTS) {
      coreLogger.warn({ serverId: server.id, attempts }, 'MCP server reconnect gave up after max attempts');
      return;
    }
    const delay = Math.min(
      MCPBridge.RECONNECT_BASE_MS * 2 ** attempts,
      MCPBridge.RECONNECT_MAX_MS,
    );
    this.reconnectAttempts.set(server.id, attempts + 1);
    coreLogger.info({ serverId: server.id, attempt: attempts + 1, delayMs: delay }, 'Scheduling MCP server reconnect');

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(server.id);
      if (this.intentionalDisconnects.has(server.id)) return;
      // Drop the stale connection so connect() doesn't short-circuit on it.
      const stale = this.connections.get(server.id);
      if (stale) {
        stale.transport.close();
        stale.protocol.cleanup();
        this.connections.delete(server.id);
      }
      this.connect(server).catch((err: unknown) => {
        coreLogger.error({ err, serverId: server.id }, 'MCP reconnect attempt failed');
        this.scheduleReconnect(server);
      });
    }, delay);
    // Don't let a pending reconnect keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    this.reconnectTimers.set(server.id, timer);
  }

  /**
   * Connect to all configured servers
   */
  async connectAll(): Promise<void> {
    const config = getConfig();

    if (!config.mcp.autoStart) {
      return;
    }

    await this.loadConfig();

    for (const server of this.serverConfigs) {
      if (server.isEnabled) {
        try {
          await this.connect(server);
        } catch (error) {
          coreLogger.error({ error, serverId: server.id }, 'Failed to connect to MCP server');
        }
      }
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    // Cancel reconnects for servers currently between backoff attempts (dropped
    // from `connections`, so the loop below wouldn't otherwise reach them).
    for (const serverId of [...this.reconnectTimers.keys()]) {
      this.intentionalDisconnects.add(serverId);
      this.clearReconnectTimer(serverId);
    }
    for (const serverId of [...this.connections.keys()]) {
      await this.disconnect(serverId);
    }
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const breaker = getMcpCircuitBreaker();
    if (!breaker.canCall(serverId)) {
      const st = breaker.getState(serverId);
      throw new Error(`MCP server circuit open: ${serverId} (cooldown ${st.cooldownRemainingMs}ms remaining)`);
    }

    const connection = this.connections.get(serverId);
    if (!connection || connection.status !== 'connected') {
      breaker.recordFailure(serverId);
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    const send = (message: string) => {
      connection.transport.send(message);
    };

    try {
      const result = await connection.protocol.sendRequest(send, MCPMethods.CallTool, {
        name: toolName,
        arguments: args,
      });
      breaker.recordSuccess(serverId);
      return result;
    } catch (err) {
      breaker.recordFailure(serverId);
      throw err;
    }
  }

  /**
   * Read a resource from an MCP server
   */
  async readResource(serverId: string, uri: string): Promise<unknown> {
    const connection = this.connections.get(serverId);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    const send = (message: string) => {
      connection.transport.send(message);
    };

    const result = await connection.protocol.sendRequest(send, MCPMethods.ReadResource, { uri });

    return result;
  }

  /**
   * Get a prompt from an MCP server
   */
  async getPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<unknown> {
    const connection = this.connections.get(serverId);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    const send = (message: string) => {
      connection.transport.send(message);
    };

    const result = await connection.protocol.sendRequest(send, MCPMethods.GetPrompt, {
      name,
      arguments: args,
    });

    return result;
  }

  /**
   * Get all available tools from all connected servers
   */
  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];

    for (const connection of this.connections.values()) {
      if (connection.status === 'connected') {
        for (const tool of connection.tools) {
          tools.push({
            serverId: connection.id,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
      }
    }

    return tools;
  }

  /**
   * Get connection status
   */
  getConnection(serverId: string): MCPServerConnection | undefined {
    return this.connections.get(serverId);
  }

  /**
   * Get all connections
   */
  getAllConnections(): MCPServerConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Check if a server is connected
   */
  isConnected(serverId: string): boolean {
    const connection = this.connections.get(serverId);
    return connection?.status === 'connected';
  }

  /**
   * Get all server configs (connected or not)
   */
  getServerConfigs(): MCPServer[] {
    return [...this.serverConfigs];
  }

  /**
   * Add a new MCP server config and persist to file
   */
  async addServer(server: MCPServer): Promise<void> {
    // Avoid duplicates
    const idx = this.serverConfigs.findIndex((s) => s.id === server.id);
    if (idx >= 0) {
      this.serverConfigs[idx] = server;
    } else {
      this.serverConfigs.push(server);
    }

    await this.saveConfig();
    coreLogger.info({ serverId: server.id }, 'MCP server config added');
  }

  /**
   * Remove an MCP server config and disconnect if running
   */
  async removeServer(serverId: string): Promise<boolean> {
    const idx = this.serverConfigs.findIndex((s) => s.id === serverId);
    if (idx < 0) return false;

    await this.disconnect(serverId);
    this.serverConfigs.splice(idx, 1);
    await this.saveConfig();

    coreLogger.info({ serverId }, 'MCP server config removed');
    return true;
  }

  /**
   * Update server enabled state
   */
  async toggleServer(serverId: string, enabled: boolean): Promise<boolean> {
    const server = this.serverConfigs.find((s) => s.id === serverId);
    if (!server) return false;

    server.isEnabled = enabled;
    await this.saveConfig();

    if (enabled) {
      await this.connect(server).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in bridge'));
    } else {
      await this.disconnect(serverId);
    }

    return true;
  }

  /**
   * Persist current server configs to JSON file (if configured) or database.
   */
  private async saveConfig(): Promise<void> {
    const config = getConfig();

    // Prefer file-based storage if explicitly configured
    if (config.mcp.serversConfigPath) {
      const content = JSON.stringify({ servers: this.serverConfigs }, null, 2);
      await Bun.write(config.mcp.serversConfigPath, content);
      return;
    }

    // Fall back to database storage
    try {
      const settingsService = getSettingsService();
      await settingsService.set('mcp.servers', this.serverConfigs);
      coreLogger.debug({ count: this.serverConfigs.length }, 'MCP server configs saved to database');
    } catch (error) {
      coreLogger.error({ error }, 'Failed to save MCP server configs to database');
    }
  }

  /**
   * Convert all MCP tools into ToolHandlers usable by AgentWorker.
   * WARNING: This expands every tool into a separate handler, which can flood
   * the model context when many MCP servers are connected. Prefer
   * getLazyToolHandlers() for agent use.
   */
  getToolHandlers(): ToolHandler[] {
    const handlers: ToolHandler[] = [];
    const bridge = this; // capture for closures

    for (const connection of this.connections.values()) {
      if (connection.status !== 'connected') continue;

      for (const tool of connection.tools) {
        const serverId = connection.id;
        handlers.push({
          name: `mcp_${serverId}_${tool.name}`,
          description: `[MCP:${connection.server.name}] ${tool.description}`,
          parameters: tool.inputSchema,
          toolId: `mcp:${serverId}`,
          execute: async (args) => {
            return bridge.callTool(serverId, tool.name, args);
          },
        });
      }
    }

    return handlers;
  }

  /**
   * Get two lightweight meta-tools (mcp_list_tools, mcp_call_tool) that let
   * agents discover and invoke MCP tools on demand, without flooding the
   * model context with every tool definition upfront.
   */
  getLazyToolHandlers(): ToolHandler[] {
    const bridge = this;

    // Don't add meta-tools if no MCP servers are connected
    const hasConnected = Array.from(this.connections.values()).some(c => c.status === 'connected');
    if (!hasConnected) return [];

    return [
      {
        name: 'mcp_list_tools',
        description:
          'List available tools from connected MCP (Model Context Protocol) servers. ' +
          'Call this to discover what external tools are available before calling mcp_call_tool. ' +
          'Returns server names and their tools with descriptions and parameter schemas.',
        parameters: {
          type: 'object',
          properties: {
            server_id: {
              type: 'string',
              description: 'Optional: filter by a specific server ID. Omit to list all servers and tools.',
            },
          },
        },
        toolId: 'mcp',
        execute: async (args) => {
          const serverId = args.server_id as string | undefined;
          const result: Array<{
            server_id: string;
            server_name: string;
            tools: Array<{ name: string; description: string; parameters?: unknown }>;
          }> = [];

          for (const connection of bridge.connections.values()) {
            if (connection.status !== 'connected') continue;
            if (serverId && connection.id !== serverId) continue;

            result.push({
              server_id: connection.id,
              server_name: connection.server.name,
              tools: connection.tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              })),
            });
          }

          if (result.length === 0) {
            return { message: serverId ? `MCP server '${serverId}' not found or not connected.` : 'No MCP servers connected.' };
          }

          return result;
        },
      },
      {
        name: 'mcp_call_tool',
        description:
          'Call a tool on a connected MCP server. Use mcp_list_tools first to discover available tools, ' +
          'server IDs, and parameter schemas.',
        parameters: {
          type: 'object',
          properties: {
            server_id: {
              type: 'string',
              description: 'The MCP server ID (from mcp_list_tools)',
            },
            tool_name: {
              type: 'string',
              description: 'The tool name to call (from mcp_list_tools)',
            },
            arguments: {
              type: 'object',
              description: 'Arguments to pass to the tool (see parameter schema from mcp_list_tools)',
            },
          },
          required: ['server_id', 'tool_name'],
        },
        toolId: 'mcp',
        execute: async (args) => {
          const serverId = args.server_id as string;
          const toolName = args.tool_name as string;
          const toolArgs = (args.arguments as Record<string, unknown>) || {};

          return bridge.callTool(serverId, toolName, toolArgs);
        },
      },
    ];
  }
}

// Singleton instance
let bridgeInstance: MCPBridge | null = null;

export function getMCPBridge(): MCPBridge {
  if (!bridgeInstance) {
    bridgeInstance = new MCPBridge();
  }
  return bridgeInstance;
}
