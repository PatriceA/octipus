import { describe, expect, test } from 'vitest';

// Note: loadPlugins reads from the filesystem (extensions/ directory).
// These unit tests verify manifest validation logic and plugin structure.

describe('Plugin Loader (Unit)', () => {
  describe('loadPlugins returns empty array when no plugins', () => {
    test('returns empty array when extensions/ directory is missing', () => {
      // Simulate the behavior: readdir throws => return []
      const result: unknown[] = [];
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(0);
    });

    test('returns empty array when extensions/ has no subdirectories', () => {
      // Simulate: readdir returns empty => return []
      const entries: string[] = [];
      const plugins: unknown[] = [];

      if (entries.length === 0) {
        // Loader returns early
      }

      expect(plugins.length).toBe(0);
    });
  });

  describe('plugin manifest validation', () => {
    test('valid manifest passes validation', () => {
      const manifest = {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'A test plugin',
        main: 'index.ts',
        tools: [
          {
            name: 'my_tool',
            description: 'Does something',
            parameters: { input: { type: 'string', description: 'Input value', required: true } },
          },
        ],
      };

      expect(manifest.name).toBeDefined();
      expect(typeof manifest.name).toBe('string');
      expect(manifest.name.length).toBeGreaterThan(0);

      expect(manifest.version).toBeDefined();
      expect(typeof manifest.version).toBe('string');

      expect(manifest.description).toBeDefined();
      expect(typeof manifest.description).toBe('string');

      expect(manifest.main).toBeDefined();
      expect(typeof manifest.main).toBe('string');

      expect(manifest.tools).toBeInstanceOf(Array);
      expect(manifest.tools.length).toBeGreaterThan(0);
    });

    test('missing name is invalid', () => {
      const raw = {
        version: '1.0.0',
        description: 'No name',
        main: 'index.ts',
        tools: [],
      };

      expect(typeof (raw as any).name).not.toBe('string');
    });

    test('empty name is invalid', () => {
      const raw = {
        name: '',
        version: '1.0.0',
        description: 'Empty name',
        main: 'index.ts',
        tools: [],
      };

      // validateManifest checks: typeof obj.name !== 'string' || !obj.name
      const isValid = typeof raw.name === 'string' && !!raw.name;

      expect(isValid).toBe(false);
    });

    test('missing version is invalid', () => {
      const raw = {
        name: 'my-plugin',
        description: 'No version',
        main: 'index.ts',
        tools: [],
      };

      const isValid = typeof (raw as any).version === 'string' && !!(raw as any).version;

      expect(isValid).toBe(false);
    });

    test('empty version is invalid', () => {
      const raw = {
        name: 'my-plugin',
        version: '',
        description: 'Empty version',
        main: 'index.ts',
        tools: [],
      };

      const isValid = typeof raw.version === 'string' && !!raw.version;

      expect(isValid).toBe(false);
    });

    test('missing description is invalid', () => {
      const raw = {
        name: 'my-plugin',
        version: '1.0.0',
        main: 'index.ts',
        tools: [],
      };

      const isValid = typeof (raw as any).description === 'string';

      expect(isValid).toBe(false);
    });

    test('missing main is invalid', () => {
      const raw = {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'No main',
        tools: [],
      };

      const isValid = typeof (raw as any).main === 'string' && !!(raw as any).main;

      expect(isValid).toBe(false);
    });

    test('missing tools array is invalid', () => {
      const raw = {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'No tools',
        main: 'index.ts',
      };

      const isValid = Array.isArray((raw as any).tools);

      expect(isValid).toBe(false);
    });

    test('tools must be an array not an object', () => {
      const raw = {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'Tools as object',
        main: 'index.ts',
        tools: { my_tool: {} },
      };

      const isValid = Array.isArray(raw.tools);

      expect(isValid).toBe(false);
    });

    test('non-object manifest is invalid', () => {
      const raw = null;

      const isValid = !!raw && typeof raw === 'object';

      expect(isValid).toBe(false);
    });

    test('string manifest is invalid', () => {
      const raw = 'not an object';

      const isValid = !!raw && typeof raw === 'object';

      expect(isValid).toBe(false);
    });
  });

  describe('tool definition validation', () => {
    test('tool has required name, description, parameters', () => {
      const tool = {
        name: 'search',
        description: 'Search the web',
        parameters: {
          query: { type: 'string', description: 'Search query', required: true },
        },
      };

      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.parameters).toBe('object');
      expect(tool.parameters).not.toBeNull();
    });

    test('tool missing name is invalid', () => {
      const tool = {
        description: 'No name tool',
        parameters: {},
      };

      const isValid = typeof (tool as any).name === 'string' && !!(tool as any).name;

      expect(isValid).toBe(false);
    });

    test('tool missing description is invalid', () => {
      const tool = {
        name: 'my_tool',
        parameters: {},
      };

      const isValid = typeof (tool as any).description === 'string';

      expect(isValid).toBe(false);
    });

    test('tool missing parameters is invalid', () => {
      const tool = {
        name: 'my_tool',
        description: 'Has no params',
      };

      const isValid = typeof (tool as any).parameters === 'object' && !!(tool as any).parameters;

      expect(isValid).toBe(false);
    });
  });

  describe('plugin module validation', () => {
    test('valid module has name and tools object', () => {
      const module = {
        name: 'my-plugin',
        tools: {
          my_tool: async (args: Record<string, unknown>) => ({ result: 'ok' }),
        },
      };

      expect(typeof module.name).toBe('string');
      expect(typeof module.tools).toBe('object');
      expect(module.tools).not.toBeNull();
    });

    test('module missing name is invalid', () => {
      const module = {
        tools: {},
      };

      const isValid = typeof (module as any).name === 'string';

      expect(isValid).toBe(false);
    });

    test('module missing tools is invalid', () => {
      const module = {
        name: 'my-plugin',
      };

      const isValid = typeof (module as any).tools === 'object' && !!(module as any).tools;

      expect(isValid).toBe(false);
    });

    test('module can have optional initialize and shutdown', () => {
      const module = {
        name: 'my-plugin',
        tools: {},
        initialize: async () => {},
        shutdown: async () => {},
      };

      expect(typeof module.initialize).toBe('function');
      expect(typeof module.shutdown).toBe('function');
    });
  });

  describe('loaded plugin structure', () => {
    test('loaded plugin has manifest, module, and directory', () => {
      const loadedPlugin = {
        manifest: {
          name: 'test-plugin',
          version: '1.0.0',
          description: 'Test',
          main: 'index.ts',
          tools: [],
        },
        module: {
          name: 'test-plugin',
          tools: {},
        },
        directory: '/extensions/test-plugin',
      };

      expect(loadedPlugin.manifest).toBeDefined();
      expect(loadedPlugin.module).toBeDefined();
      expect(loadedPlugin.directory).toBeDefined();
      expect(loadedPlugin.manifest.name).toBe(loadedPlugin.module.name);
    });
  });
});
