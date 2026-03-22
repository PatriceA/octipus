import type { PluginContext } from '../../src/plugins/types';

export default {
  name: 'example-plugin',

  async initialize(context: PluginContext): Promise<void> {
    context.logger.info('Example plugin initialized');
  },

  tools: {
    async greet(args: Record<string, unknown>): Promise<unknown> {
      const name = args.name as string;
      return { message: `Hello, ${name}! Welcome to the assistant plugin system.` };
    },

    async calculate(args: Record<string, unknown>): Promise<unknown> {
      const operation = args.operation as string;
      const a = Number(args.a);
      const b = Number(args.b);

      switch (operation) {
        case 'add':
          return { result: a + b, expression: `${a} + ${b} = ${a + b}` };
        case 'subtract':
          return { result: a - b, expression: `${a} - ${b} = ${a - b}` };
        case 'multiply':
          return { result: a * b, expression: `${a} * ${b} = ${a * b}` };
        case 'divide':
          if (b === 0) {
            return { error: 'Division by zero' };
          }
          return { result: a / b, expression: `${a} / ${b} = ${a / b}` };
        default:
          return { error: `Unknown operation: ${operation}. Use add, subtract, multiply, or divide.` };
      }
    },
  },

  async shutdown(): Promise<void> {
    // Cleanup if needed
  },
};
