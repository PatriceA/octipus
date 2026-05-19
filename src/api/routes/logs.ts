import { Elysia, t } from 'elysia';
import { isAdmin, isAuthenticated } from '@/security/principal';
import { getRecent, getStats, logEvents } from '@/utils/log-stream';

/**
 * Log health dashboard endpoints.
 *
 *   GET  /api/logs/recent?limit=200   -> snapshot of ring buffer
 *   GET  /api/logs/stats               -> counters by level/component, errors/min
 *   GET  /api/logs/stream              -> SSE stream of new records
 *
 * Admin-only — logs may contain sensitive payloads.
 */

type Ctx = {
  set: { status?: number | string; headers: Record<string, string> };
  user: { isAdmin?: boolean } | null;
  principal: import('@/security/principal').Principal;
  request: Request;
};

function guard(ctx: Ctx): { ok: true } | { ok: false; body: { error: string } } {
  if (!ctx.user || !isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return { ok: false, body: { error: 'Authentication required' } };
  }
  if (!isAdmin(ctx.principal)) {
    ctx.set.status = 403;
    return { ok: false, body: { error: 'Admin access required' } };
  }
  return { ok: true };
}

export const logRoutes = new Elysia({ prefix: '/logs' })
  .get(
    '/recent',
    (ctx: any) => {
      const g = guard(ctx);
      if (!g.ok) return g.body;
      const limit = Number(ctx.query?.limit ?? 200);
      return { logs: getRecent(limit) };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )
  .get('/stats', (ctx: any) => {
    const g = guard(ctx);
    if (!g.ok) return g.body;
    return getStats();
  })
  .get('/stream', (ctx: any) => {
    const g = guard(ctx);
    if (!g.ok) return g.body;

    ctx.set.headers['content-type'] = 'text/event-stream';
    ctx.set.headers['cache-control'] = 'no-cache';
    ctx.set.headers['connection'] = 'keep-alive';
    ctx.set.headers['x-accel-buffering'] = 'no';

    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true;
          }
        };
        const send = (rec: unknown) => {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`));
        };
        // Replay a small backlog so the dashboard isn't empty on connect.
        for (const rec of getRecent(100)) send(rec);
        const onLog = (rec: unknown) => send(rec);
        logEvents.on('log', onLog);

        const ping = setInterval(() => {
          safeEnqueue(encoder.encode(': ping\n\n'));
        }, 15_000);

        const cleanup = () => {
          if (closed) return;
          closed = true;
          logEvents.off('log', onLog);
          clearInterval(ping);
          try {
            controller.close();
          } catch {}
        };
        ctx.request.signal.addEventListener('abort', cleanup);
      },
    });
  });
