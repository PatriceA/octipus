import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { ToolRegistry, getToolRegistry } from './registry';
import type { BaseTool, ToolAvailability } from './base-tool';

describe('ToolRegistry (Unit)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  const createMockTool = (id: string, handlers: any[] = []): BaseTool => {
    return {
      id,
      name: `name-${id}`,
      version: '1.0.0',
      initialize: mock(async () => {}),
      shutdown: mock(async () => {}),
      checkAvailability: mock(async (): Promise<ToolAvailability> => ({ available: true })),
      getToolHandlers: mock(() => handlers as any[]),
      getTool: mock((name: string) => handlers.find(h => h.name === name)),
      getManifest: mock(() => ({ id, name: `name-${id}`, version: '1.0.0', description: 'mock', tools: [] }))
    } as any as BaseTool;
  };

  test('can register and retrieve a tool', async () => {
    const tool = createMockTool('mock-tool');
    await registry.register(tool);
    expect(registry.get('mock-tool')).toBe(tool);
    expect(registry.has('mock-tool')).toBe(true);
    expect(registry.count).toBe(1);
    expect(registry.getAll()).toHaveLength(1);
  });

  test('prevents duplicate registration', async () => {
    const tool = createMockTool('mock-tool');
    await registry.register(tool);
    expect(registry.register(tool)).rejects.toThrow('Tool already registered: mock-tool');
  });

  test('initializes on registration by default', async () => {
    const tool = createMockTool('mock-tool');
    await registry.register(tool);
    expect(tool.initialize).toHaveBeenCalled();
    expect(registry.isInitialized('mock-tool')).toBe(true);
    expect(registry.initializedCount).toBe(1);
  });

  test('skips initialization if autoInitialize is false', async () => {
    const tool = createMockTool('mock-tool');
    await registry.register(tool, { autoInitialize: false });
    expect(tool.initialize).not.toHaveBeenCalled();
    expect(registry.isInitialized('mock-tool')).toBe(false);
  });

  test('initializeAll initializes all unregistered tools', async () => {
    const tool1 = createMockTool('t1');
    const tool2 = createMockTool('t2');
    await registry.register(tool1, { autoInitialize: false });
    await registry.register(tool2, { autoInitialize: false });
    
    await registry.initializeAll();
    expect(tool1.initialize).toHaveBeenCalled();
    expect(tool2.initialize).toHaveBeenCalled();
    expect(registry.isInitialized('t1')).toBe(true);
    expect(registry.isInitialized('t2')).toBe(true);
  });

  test('checkAvailability caches results', async () => {
    const tool = createMockTool('mock-tool');
    await registry.register(tool);
    
    const result1 = await registry.checkAvailability('mock-tool');
    const result2 = await registry.checkAvailability('mock-tool');
    
    expect(result1.available).toBe(true);
    expect(tool.checkAvailability).toHaveBeenCalledTimes(1); // Cached
  });

  test('checkAvailability returns false if tool not found', async () => {
    const result = await registry.checkAvailability('unknown');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('Tool not found');
  });

  test('getAllToolHandlers aggregates handlers', async () => {
    const handler1 = { name: 'h1' } as any;
    const handler2 = { name: 'h2' } as any;
    const tool1 = createMockTool('t1', [handler1]);
    const tool2 = createMockTool('t2', [handler2]);
    
    await registry.register(tool1);
    await registry.register(tool2);
    
    const handlers = registry.getAllToolHandlers();
    expect(handlers.length).toBe(2);
    expect(handlers).toContain(handler1);
    expect(handlers).toContain(handler2);
  });

  test('unregister removes and shuts down tool', async () => {
    const tool = createMockTool('mock-tool');
    await registry.register(tool);
    
    await registry.unregister('mock-tool');
    expect(registry.has('mock-tool')).toBe(false);
    expect(registry.isInitialized('mock-tool')).toBe(false);
    expect(tool.shutdown).toHaveBeenCalled();
  });

  test('shutdownAll shuts down all tools', async () => {
    const tool1 = createMockTool('t1');
    const tool2 = createMockTool('t2');
    await registry.register(tool1);
    await registry.register(tool2);
    
    await registry.shutdownAll();
    expect(tool1.shutdown).toHaveBeenCalled();
    expect(tool2.shutdown).toHaveBeenCalled();
    expect(registry.initializedCount).toBe(0);
  });

  test('getToolRegistry returns singleton', () => {
    const reg1 = getToolRegistry();
    const reg2 = getToolRegistry();
    expect(reg1).toBe(reg2);
  });
});
