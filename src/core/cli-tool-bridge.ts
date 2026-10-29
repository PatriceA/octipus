import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import { agentLogger } from '@/utils/logger';
import type { ToolHandler } from './agent-base';

/**
 * A refusal the calling CLI agent is meant to read and act on ("that tool is
 * not yours", "this run is over"). Anything else reaching the catch below is
 * an unexpected fault, and its message can carry stack/internal detail — that
 * goes to the log, and the caller gets a flat failure instead (CodeQL
 * js/stack-trace-exposure).
 */
class BridgeError extends Error {
  constructor(message: string, readonly code?: string, readonly executed?: boolean) { super(message); }
}

const callSchema = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) }).strict();
export interface BridgeResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/** A tool that takes its own `timeout` (shell__run) ends itself with a clean result; never cut it off first. */
function ownTimeout(name: string, args: Record<string, unknown>, tools: ToolHandler[], floor = 0): number {
  const tool = tools.find(t => t.name === name);
  const schema = tool?.parameters as { properties?: { timeout?: { default?: unknown } } } | undefined;
  const configured = typeof tool?.executionTimeoutMs === 'function' ? tool.executionTimeoutMs(args) : tool?.executionTimeoutMs;
  const values = [args.timeout ?? schema?.properties?.timeout?.default, configured]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values, floor) : 0;
}

/** A run-local capability, never an API/admin credential. No caller-supplied identity. */
export async function startCliToolBridge(options: {
  tools: () => ToolHandler[];
  registered?: (name: string) => boolean;
  /** Tools the executor blocked after repeated failures — named in the refusal. */
  blocked?: (name: string) => boolean;
  advertisedTools?: () => ToolHandler[];
  execute: (name: string, args: Record<string, unknown>) => Promise<BridgeResult>;
  active: () => boolean;
  /** A live call lost its caller; cancel approval waits, never replay the call. */
  abandoned?: (name: string) => void;
  /** Read-only tools that bypass the per-worker queue (safe to answer while a delegation blocks it). */
  unqueued?: ReadonlySet<string>;
  /** Queue wait after the call ahead settles or expires, and execution on top of the tool's own `timeout`; the running mutation retains its queue slot until it settles. */
  timeoutMs?: number;
  /** Delegation waits (spawn_child, collect_children): no bridge clock once running; the CLI's own tool timeout bounds them. */
  longWait?: ReadonlySet<string>;
  /** Minimum the tool itself applies to its own `timeout` (pipeline shell floor); the bridge must not cut in below it. */
  toolTimeoutFloorMs?: number;
  /** The caller dropped the connection before this tool's result could be sent. */
  undelivered?: (name: string) => void;
  /** Called after a response is flushed, including a terminal approval refusal. */
  delivered?: () => void;
}): Promise<{ url: string; key: string; close: () => Promise<void>;
  setApprovalWaiting: (waiting: boolean) => void; endApprovalWait: (reason: string) => boolean }> {
  const key = randomBytes(32).toString('hex');
  let closed = false;
  let closing: Promise<void> | undefined;
  // Only the serialized executor can wait on permissions. Unqueued context
  // reads must never take ownership of its approval state or deadline.
  let approvalCall: { waiting: boolean; change: (waiting: boolean) => void; end: (reason: string) => void } | undefined;
  // Serialize calls to the worker's executor; separate agents have separate queues.
  let queue = Promise.resolve();
  // Settles when the call ahead settles or passes its own deadline; a queued call's wait clock starts there.
  let queueBounded = Promise.resolve();
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value), () => options.delivered?.());
    };
    const socket = req.socket;
    let expired = false;
    const unqueued = (name: string) => options.unqueued?.has(name) || ['get_pipeline_status', 'monitor__list', 'monitor__create', 'answer_pipeline_approval'].includes(name);
    let started = false;
    let settled = false;
    let toolName: string | undefined;
    const onClose = () => {
      if (!res.writableEnded && started && !settled && toolName && !unqueued(toolName)) options.abandoned?.(toolName);
    };
    res.on('close', onClose);
    try {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${key}`);
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(401, { error: 'Invalid agent capability' }); return;
    }
    if (closed || !options.active()) { reply(410, { error: 'Agent run is no longer active' }); return; }
      if (req.method === 'GET' && req.url === '/tools') {
        const tools = (options.advertisedTools?.() ?? options.tools()).map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
        if (options.advertisedTools && options.tools().length) tools.push({ name: 'call_discovered_tool',
          description: 'Call an Octipus tool discovered through list_tools/describe_tool using its exact name and arguments.',
          inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] } });
        reply(200, { tools });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/call') { reply(404, { error: 'Not found' }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { reply(413, { error: 'Tool arguments exceed 1 MiB' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const input = callSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (input.name === 'call_discovered_tool' && options.advertisedTools) {
        const target = callSchema.parse(input.arguments);
        input.name = target.name;
        input.arguments = target.arguments;
      }
      toolName = input.name;
      const base = options.timeoutMs ?? 30_000;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let bounded!: () => void;
      const mine = new Promise<void>(resolve => { bounded = resolve; });
      let expire!: (err: Error) => void;
      const timedOut = new Promise<never>((_, reject) => { expire = reject; });
      const executionBudget = base + ownTimeout(input.name, input.arguments, options.tools(), options.toolTimeoutFloorMs);
      const approval = {
        waiting: false,
        change: (waiting: boolean) => {
          approval.waiting = waiting;
          clearTimeout(deadline);
          // The worker owns the separate five-minute human decision deadline.
          if (!waiting && !expired && !settled && !options.longWait?.has(input.name)) arm(executionBudget);
        },
        end: (reason: string) => {
          expired = true;
          clearTimeout(deadline);
          bounded();
          expire(new BridgeError(reason, 'approval_timeout', false));
        },
      };
      // One clock per phase: queue wait (base) once the call ahead is done or
      // expired, then execution (base + the tool's own timeout) once it starts.
      const arm = (ms: number) => {
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          expired = true;
          bounded();
          if (started && !settled && !unqueued(input.name)) options.abandoned?.(input.name);
          expire(new BridgeError(`Tool ${input.name} timed out after ${ms}ms. ${started ? 'Execution may have started; inspect its outcome before retrying.' : 'The queued call was not executed.'}`));
        }, ms);
      };
      const run = async () => {
        if (expired || res.destroyed) throw new BridgeError('Tool caller disconnected or timed out before execution');
        if (closed || !options.active()) throw new BridgeError('Agent run is no longer active');
        // Exact membership check before ToolExecutor's fuzzy name recovery.
        if (!options.tools().some(t => t.name === input.name)) {
          // A CLI agent never sees the executor's system message, so say why here.
          if (options.blocked?.(input.name)) throw new BridgeError(
            `Tool ${input.name} is blocked for this run after failing the same way repeatedly; use other tools and report the failure`, 'TOOL_BLOCKED', false);
          if (options.registered?.(input.name)) throw new BridgeError(
            'Tool is registered but unavailable under this run permission state', 'TOOL_PERMISSION_DENIED', false);
          throw new BridgeError('Tool is not registered in this agent authorized tool set. Call list_tools; this does not establish whether the tool exists elsewhere in Octipus.', 'TOOL_NOT_REGISTERED_FOR_AGENT', false);
        }
        started = true;
        if (!unqueued(input.name)) approvalCall = approval;
        if (options.longWait?.has(input.name)) clearTimeout(deadline);
        else arm(executionBudget);
        try { return await options.execute(input.name, input.arguments); }
        finally { settled = true; if (approvalCall === approval) approvalCall = undefined; }
      };
      // ponytail: one queue per worker; unqueued read-only tools keep context reads
      // responsive while an awaited delegation holds the queue. Parallel executor
      // calls if ToolExecutor's counters/final-flag are ever made concurrency-safe.
      let operation: Promise<BridgeResult>;
      const ahead = unqueued(input.name) ? Promise.resolve() : queueBounded;
      if (unqueued(input.name)) operation = run();
      else {
        queueBounded = mine;
        operation = queue.then(run); queue = operation.then(() => undefined, () => undefined);
      }
      void ahead.then(() => { if (!started && !expired) arm(base); });
      operation.then(bounded, bounded);
      let result: BridgeResult;
      try {
        result = await Promise.race([operation, timedOut]);
      } finally { clearTimeout(deadline); if (approvalCall === approval) approvalCall = undefined; }
      // The caller gave up (transport timeout, cancel) while the tool ran; a
      // write now goes nowhere, so let the owner keep what it would lose.
      if (socket.destroyed) { options.undelivered?.(input.name); options.delivered?.(); return; }
      reply(200, result);
    } catch (err) {
      // A deliberate refusal is the agent's to read; a malformed call gets the
      // schema complaint, which is about ITS request, not our internals.
      if (err instanceof BridgeError || err instanceof z.ZodError) {
        reply(400, { error: err instanceof z.ZodError ? `Invalid tool call: ${err.issues.map(i => i.message).join('; ')}` : err.message,
          ...(err instanceof BridgeError && err.code ? { code: err.code, executed: err.executed } : {}) });
        return;
      }
      agentLogger.error({ err }, 'CLI tool bridge request failed');
      if (!res.destroyed) reply(500, { error: 'Tool call failed' });
    } finally {
      res.removeListener('close', onClose);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Agent bridge has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`, key,
    setApprovalWaiting: waiting => approvalCall?.change(waiting),
    endApprovalWait: reason => {
      if (!approvalCall?.waiting) return false;
      approvalCall.end(reason);
      return true;
    },
    close: () => {
      if (!closing) {
        closed = true;
        server.closeAllConnections();
        closing = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      }
      return closing;
    },
  };
}
