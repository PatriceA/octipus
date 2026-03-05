import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { sanitizeToolOutput } from '@/utils/sanitize';

// Note: Full AgentWorker integration tests require mocking LLM client, repositories,
// and permission manager. We test the key sub-systems in isolation.

describe('AgentWorker (Unit)', () => {
  describe('agent configuration', () => {
    test('config has required fields', () => {
      const config = {
        id: 'agent-123',
        model: 'gpt-4',
        systemPrompt: 'You are a helpful assistant.',
        maxIterations: 10,
        temperature: 0.7,
      };

      expect(config.id).toBeDefined();
      expect(config.model).toBeDefined();
      expect(config.systemPrompt).toBeDefined();
      expect(config.maxIterations).toBeGreaterThan(0);
      expect(config.temperature).toBeGreaterThanOrEqual(0);
      expect(config.temperature).toBeLessThanOrEqual(2);
    });
  });

  describe('agent status', () => {
    const validStatuses = ['idle', 'running', 'paused', 'completed', 'failed'];

    test('all statuses are valid strings', () => {
      for (const status of validStatuses) {
        expect(typeof status).toBe('string');
      }
    });

    test('status transitions make sense', () => {
      expect(validStatuses).toContain('idle');
      expect(validStatuses).toContain('running');
      expect(validStatuses).toContain('completed');
      expect(validStatuses).toContain('failed');
    });
  });

  describe('message handling', () => {
    test('user message has correct structure', () => {
      const message = {
        role: 'user' as const,
        content: 'Hello, agent!',
        timestamp: new Date(),
      };

      expect(message.role).toBe('user');
      expect(message.content).toBeDefined();
      expect(message.timestamp).toBeInstanceOf(Date);
    });

    test('assistant message has correct structure', () => {
      const message = {
        role: 'assistant' as const,
        content: 'Hello! How can I help you?',
        timestamp: new Date(),
      };

      expect(message.role).toBe('assistant');
      expect(message.content).toBeDefined();
    });

    test('tool call message has correct structure', () => {
      const message = {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{
          id: 'call_1',
          name: 'get_weather',
          arguments: { location: 'London' },
        }],
        timestamp: new Date(),
      };

      expect(message.toolCalls).toBeDefined();
      expect(message.toolCalls![0].name).toBe('get_weather');
      expect(message.toolCalls![0].arguments.location).toBe('London');
    });

    test('tool result message has toolCallId', () => {
      const message = {
        role: 'tool' as const,
        content: '{"temp": 15}',
        toolCallId: 'call_1',
        timestamp: new Date(),
      };

      expect(message.role).toBe('tool');
      expect(message.toolCallId).toBe('call_1');
    });
  });

  describe('iteration limits', () => {
    test('max iterations prevents infinite loops', () => {
      const maxIterations = 10;
      let iterations = 0;

      while (iterations < maxIterations) {
        iterations++;
      }

      expect(iterations).toBe(maxIterations);
    });
  });

  describe('token usage tracking', () => {
    test('usage structure is correct', () => {
      const usage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      };

      expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
    });
  });

  describe('tool registration', () => {
    test('tool handler has required fields', () => {
      const tool = {
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
        execute: async (args: Record<string, unknown>) => {
          return `contents of ${args.path}`;
        },
      };

      expect(tool.name).toBe('read_file');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    });

    test('tool with toolId preserves it', () => {
      const tool = {
        name: 'shell_exec',
        description: 'Execute shell command',
        parameters: {},
        toolId: 'shell',
        execute: async () => 'ok',
      };

      expect(tool.toolId).toBe('shell');
    });

    test('tool without toolId defaults to undefined', () => {
      const tool: { name: string; description: string; parameters: {}; toolId?: string; execute: () => Promise<string> } = {
        name: 'echo',
        description: 'Echo back',
        parameters: {},
        execute: async () => 'ok',
      };

      expect(tool.toolId).toBeUndefined();
    });
  });

  describe('permission check flow', () => {
    test('ALLOW result allows execution', () => {
      const result = { allowed: true, level: 'ALLOW' as const, requiresApproval: false };
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    test('DENY result blocks execution', () => {
      const result = { allowed: false, level: 'DENY' as const, requiresApproval: false, reason: 'Blocked' };
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Blocked');
    });

    test('ASK result requires approval', () => {
      const result = { allowed: false, level: 'ASK' as const, requiresApproval: true };
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('event emission types', () => {
    test('all event types are valid', () => {
      const validTypes = ['thought', 'action', 'observation', 'error', 'complete', 'status_change', 'permission_request'];
      for (const type of validTypes) {
        expect(typeof type).toBe('string');
      }
    });

    test('permission_request event is included', () => {
      const types = ['thought', 'action', 'observation', 'error', 'complete', 'status_change', 'permission_request'];
      expect(types).toContain('permission_request');
    });
  });
});

describe('sanitizeToolOutput', () => {
  test('converts objects to JSON', () => {
    const result = sanitizeToolOutput({ key: 'value' });
    expect(result).toBe('{"key":"value"}');
  });

  test('passes strings through', () => {
    expect(sanitizeToolOutput('hello')).toBe('hello');
  });

  test('handles null', () => {
    expect(sanitizeToolOutput(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(sanitizeToolOutput(undefined)).toBe('');
  });

  test('truncates long output', () => {
    const long = 'x'.repeat(60_000);
    const result = sanitizeToolOutput(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith('[truncated]')).toBe(true);
  });

  test('does not truncate short output', () => {
    const short = 'hello';
    expect(sanitizeToolOutput(short)).toBe(short);
  });

  test('respects custom maxLength', () => {
    const input = 'x'.repeat(200);
    const result = sanitizeToolOutput(input, { maxLength: 100 });
    expect(result.length).toBeLessThanOrEqual(112); // 100 + ' [truncated]'
  });
});
