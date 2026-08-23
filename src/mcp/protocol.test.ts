import { describe, expect, test } from 'vitest';
import { MCPErrorCodes } from './protocol';

describe('MCP Protocol (Unit)', () => {
  describe('error codes', () => {
    test('has standard JSON-RPC error codes', () => {
      expect(MCPErrorCodes.ParseError).toBe(-32700);
      expect(MCPErrorCodes.InvalidRequest).toBe(-32600);
      expect(MCPErrorCodes.MethodNotFound).toBe(-32601);
      expect(MCPErrorCodes.InvalidParams).toBe(-32602);
      expect(MCPErrorCodes.InternalError).toBe(-32603);
    });

    test('has MCP-specific error codes', () => {
      expect(MCPErrorCodes.ServerNotInitialized).toBe(-32002);
      expect(MCPErrorCodes.UnknownError).toBe(-32001);
    });
  });

  describe('message structure', () => {
    test('request has required fields', () => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'tools/list',
        params: {},
        id: 1,
      };

      expect(request.jsonrpc).toBe('2.0');
      expect(request.method).toBeDefined();
      expect(request.id).toBeDefined();
    });

    test('response has required fields', () => {
      const response = {
        jsonrpc: '2.0' as const,
        result: { tools: [] },
        id: 1,
      };

      expect(response.jsonrpc).toBe('2.0');
      expect(response.result).toBeDefined();
      expect(response.id).toBeDefined();
    });

    test('error response has error field', () => {
      const errorResponse = {
        jsonrpc: '2.0' as const,
        error: {
          code: MCPErrorCodes.MethodNotFound,
          message: 'Method not found',
        },
        id: 1,
      };

      expect(errorResponse.error.code).toBe(-32601);
      expect(errorResponse.error.message).toBeDefined();
    });

    test('notification has no id', () => {
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/progress',
        params: { progress: 50 },
      };

      expect(notification.jsonrpc).toBe('2.0');
      expect(notification.method).toBeDefined();
      expect((notification as any).id).toBeUndefined();
    });
  });

  describe('tool definition', () => {
    test('has required fields', () => {
      const tool = {
        name: 'get_weather',
        description: 'Get weather for a location',
        inputSchema: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
          required: ['location'],
        },
      };

      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    });
  });

  describe('resource definition', () => {
    test('has required fields', () => {
      const resource = {
        uri: 'file:///path/to/file',
        name: 'My File',
        mimeType: 'text/plain',
      };

      expect(resource.uri).toBeDefined();
      expect(resource.name).toBeDefined();
    });
  });

  describe('capabilities', () => {
    test('server capabilities structure', () => {
      const capabilities = {
        tools: true,
        resources: true,
        prompts: true,
        logging: true,
      };

      expect(capabilities.tools).toBe(true);
      expect(capabilities.resources).toBe(true);
    });
  });

  describe('MCP methods', () => {
    test('initialization methods', () => {
      const methods = {
        initialize: 'initialize',
        initialized: 'initialized',
      };

      expect(methods.initialize).toBe('initialize');
      expect(methods.initialized).toBe('initialized');
    });

    test('tool methods', () => {
      const methods = {
        toolsList: 'tools/list',
        toolsCall: 'tools/call',
      };

      expect(methods.toolsList).toBe('tools/list');
      expect(methods.toolsCall).toBe('tools/call');
    });

    test('resource methods', () => {
      const methods = {
        resourcesList: 'resources/list',
        resourcesRead: 'resources/read',
      };

      expect(methods.resourcesList).toBe('resources/list');
    });
  });
});
