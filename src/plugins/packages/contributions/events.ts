/**
 * Events of plugin packages (docs/PLUGIN-PACKAGES.md#events): a gateway event
 * on the allowlist (`PLUGIN_EVENT_TYPES`) calls the package's tool, after the
 * fact and off the publisher's path.
 *
 * - The tool gets ids only: `{ event: { type, at, userId, sessionId? | documentId? } }`,
 *   never the reply, a file's contents or an error text.
 * - It runs as the user the event belongs to, unattended: a `read` tool
 *   runs; a `write` one only where that user's permission rules allow it; an
 *   `external` one never. An event of a session whose content is above the
 *   package's `maxProtection` is not delivered.
 * - At most `RATE_PER_MINUTE` deliveries a minute and `MAX_IN_FLIGHT` at once
 *   per package; the rest are dropped and the drop recorded. A failing tool
 *   never reaches the publisher or another package.
 */
import type { GatewayEvent } from '@/core/gateway/protocol';
import { isRealUserId } from '@/security/principal';
import type { PluginEventDecl, PluginEventType } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { actingContext, callPluginTool, serverIdOf } from './call';
import { recordRun } from './status';

export const RATE_PER_MINUTE = 60;
export const MAX_IN_FLIGHT = 4;

interface Budget { window: number[]; inFlight: number; dropped: number }
const budgets = new Map<string, Budget>();

/** What the tool is told about an event: ids only. Null for an event it may not see. */
export function eventPayload(on: PluginEventType, event: GatewayEvent): Record<string, unknown> | null {
  if (!isRealUserId(event.userId)) return null;
  const base = { type: on, at: new Date(event.timestamp).toISOString(), userId: event.userId };
  switch (on) {
    case 'chat.response':
      return event.sessionId ? { ...base, sessionId: event.sessionId } : null;
    case 'document.completed':
    case 'document.failed': {
      const documentId = (event.payload as { documentId?: unknown } | null)?.documentId;
      return typeof documentId === 'string' ? { ...base, documentId } : null;
    }
  }
}

function admit(pkg: string, now = Date.now()): boolean {
  const b = budgets.get(pkg) ?? { window: [], inFlight: 0, dropped: 0 };
  budgets.set(pkg, b);
  while (b.window.length > 0 && b.window[0] <= now - 60_000) b.window.shift();
  if (b.window.length >= RATE_PER_MINUTE || b.inFlight >= MAX_IN_FLIGHT) {
    b.dropped++;
    return false;
  }
  b.window.push(now);
  b.inFlight++;
  return true;
}

async function deliver(pkg: string, decl: PluginEventDecl, event: GatewayEvent, payload: Record<string, unknown>): Promise<void> {
  const runKey = `event:${decl.on}:${decl.tool}`;
  try {
    if (event.sessionId) {
      const { pluginProtectionRefusal } = await import('@/security/mcp-authorization');
      const refusal = await pluginProtectionRefusal(event.sessionId, serverIdOf(pkg));
      if (refusal) {
        await recordRun(pkg, runKey, false, `Not delivered: ${refusal}`);
        return;
      }
    }
    const context = await actingContext({ pkg, userId: event.userId as string, kind: 'event', attended: false });
    const { text, isError } = await callPluginTool(pkg, decl.tool, { event: payload }, context);
    await recordRun(pkg, runKey, !isError, isError ? text || 'The tool reported an error' : null);
  } catch (err) {
    coreLogger.warn({ err, pkg, on: decl.on }, 'Plugin event delivery failed');
    await recordRun(pkg, runKey, false, (err as Error).message);
  }
}

/** Every delivery started and not finished, for tests. */
const pending = new Set<Promise<void>>();

/** Subscribe `pkg`'s tool to its event; the disposer unsubscribes. */
export async function bindEvent(pkg: string, decl: PluginEventDecl): Promise<() => void> {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  return getGatewayHub().eventBus.subscribe(decl.on, (event) => {
    if (event.type !== decl.on) return;
    const payload = eventPayload(decl.on, event);
    if (!payload) return;
    if (!admit(pkg)) {
      const dropped = budgets.get(pkg)?.dropped ?? 0;
      // One record per ten drops: the store is not written on every event of a burst.
      if (dropped % 10 === 1) {
        void recordRun(pkg, `event:${decl.on}:${decl.tool}`, false, `Dropped ${dropped} event(s): at most ${RATE_PER_MINUTE} a minute and ${MAX_IN_FLIGHT} at once per package`);
      }
      return;
    }
    const run = deliver(pkg, decl, event, payload).finally(() => {
      const b = budgets.get(pkg);
      if (b) b.inFlight--;
      pending.delete(run);
    });
    pending.add(run);
  });
}

/** Wait for every delivery in flight (tests). */
export async function _settleEventsForTesting(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/** Forget a package's rate budget (unbound). */
export function forgetEventBudget(pkg: string): void {
  budgets.delete(pkg);
}
