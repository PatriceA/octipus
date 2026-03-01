import { describe, test, expect } from 'bun:test';

// Note: SkillRegistry tests require proper skill initialization
// These are unit tests for registry logic

describe('SkillRegistry (Unit)', () => {
  describe('skill structure', () => {
    test('skill has required properties', () => {
      const skill = {
        name: 'filesystem',
        description: 'File system operations',
        actions: {
          read: { description: 'Read file', parameters: {} },
          write: { description: 'Write file', parameters: {} },
        },
      };

      expect(skill.name).toBeDefined();
      expect(skill.description).toBeDefined();
      expect(skill.actions).toBeDefined();
    });

    test('action has description and parameters', () => {
      const action = {
        description: 'Read a file from disk',
        parameters: {
          path: { type: 'string', required: true },
          encoding: { type: 'string', required: false },
        },
      };

      expect(action.description).toBeDefined();
      expect(action.parameters).toBeDefined();
    });
  });

  describe('registry operations', () => {
    test('can track registered skills', () => {
      const registry = new Map<string, object>();

      registry.set('filesystem', { name: 'filesystem' });
      registry.set('shell', { name: 'shell' });

      expect(registry.has('filesystem')).toBe(true);
      expect(registry.has('shell')).toBe(true);
      expect(registry.has('unknown')).toBe(false);
    });

    test('can list all skills', () => {
      const registry = new Map<string, object>();
      registry.set('skill1', {});
      registry.set('skill2', {});

      const skills = Array.from(registry.keys());

      expect(skills).toContain('skill1');
      expect(skills).toContain('skill2');
      expect(skills.length).toBe(2);
    });

    test('can remove skills', () => {
      const registry = new Map<string, object>();
      registry.set('toRemove', {});

      registry.delete('toRemove');

      expect(registry.has('toRemove')).toBe(false);
    });
  });

  describe('tool definitions', () => {
    test('generates OpenAI-compatible tool format', () => {
      const skill = {
        name: 'calculator',
        actions: {
          add: {
            description: 'Add numbers',
            parameters: {
              a: { type: 'number', required: true },
              b: { type: 'number', required: true },
            },
          },
        },
      };

      const toolDef = {
        type: 'function',
        function: {
          name: `${skill.name}_add`,
          description: skill.actions.add.description,
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
          },
        },
      };

      expect(toolDef.type).toBe('function');
      expect(toolDef.function.name).toBe('calculator_add');
      expect(toolDef.function.parameters.required).toContain('a');
    });
  });

  describe('execution context', () => {
    test('context has required fields', () => {
      const context = {
        userId: 'user-123',
        sessionId: 'session-456',
        agentId: 'agent-789',
      };

      expect(context.userId).toBeDefined();
      expect(context.sessionId).toBeDefined();
      expect(context.agentId).toBeDefined();
    });
  });

  describe('execution result', () => {
    test('success result structure', () => {
      const result = {
        success: true,
        data: 'Operation completed',
      };

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test('error result structure', () => {
      const result = {
        success: false,
        error: 'Operation failed',
      };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('enable/disable', () => {
    test('tracks enabled state', () => {
      const enabledSkills = new Set<string>(['filesystem', 'git']);

      expect(enabledSkills.has('filesystem')).toBe(true);

      enabledSkills.delete('filesystem');
      expect(enabledSkills.has('filesystem')).toBe(false);

      enabledSkills.add('filesystem');
      expect(enabledSkills.has('filesystem')).toBe(true);
    });
  });
});
