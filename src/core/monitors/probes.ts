import type { AgentContext } from '@/core/types';
import type { MonitorSource } from './types';
import { isReadOnlyAction } from '@/core/action-recovery';
import { getToolRegistry } from '@/tools/registry';

/** Resolve only declared read actions; arbitrary shell/evaluate/click are never polling probes. */
export function readProbe(name: string, args: Record<string, unknown>) {
  const handler = getToolRegistry().findTool(name);
  if (!handler) throw new Error(`Unknown monitor probe: ${name}`);
  const action = typeof handler.permissionAction === 'function' ? handler.permissionAction(args) : handler.permissionAction;
  if (!action || (!isReadOnlyAction(action) && handler.replaySafety !== 'read_only')) throw new Error(`Monitor probe must be a declared read-only action: ${name}`);
  return handler;
}
export async function probe(source: MonitorSource, context: AgentContext): Promise<unknown> {
  if (source.kind === 'event') {
    if (!source.fallback) return undefined;
    return probe(source.fallback, context);
  }
  if (source.kind === 'tool') return readProbe(source.name, source.args).execute(source.args, context);
  if (source.kind === 'browser') {
    // The extension verifies URL and reads the selector in one page execution.
    return readProbe('browser-ext__observe', {}).execute({ tabId: source.tabId, url: source.url, selector: source.selector }, context);
  }
  return undefined;
}
