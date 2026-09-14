/**
 * Trusted preflight evidence: the implementation rejected this invocation before
 * starting its side effect. Never infer this from model arguments, an error
 * message, or an arbitrary tool response's fields.
 */
export class ToolNotExecutedError extends Error {
  constructor(readonly toolId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolNotExecutedError';
  }
}

// Preserve APIs that return an aborted outcome, without trusting a serializable
// flag that arbitrary tool responses or model arguments could imitate.
const unexecutedResults = new WeakMap<object, string>();

export function markToolNotExecuted<T extends object>(toolId: string, result: T): T {
  unexecutedResults.set(result, toolId);
  return result;
}

export function isToolNotExecutedResult(toolId: string, result: unknown): boolean {
  return result !== null && typeof result === 'object' && unexecutedResults.get(result) === toolId;
}
