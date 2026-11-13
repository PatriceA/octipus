import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import { agentLogger } from '@/utils/logger';
import type { ToolHandler } from './agent-base';
import { canonical } from './idempotency';

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

/**
 * Retry key a CLI agent may add to a call that changes something
 * (docs/plans/orchestration-gaps-2026-11.md §2). A call whose response was
 * lost (CLI transport timeout, dropped socket) and is retried with the same
 * `clientRequestId` gets the first call's result, or joins it while it still
 * runs, instead of creating the work again. Kept for the life of the run.
 */
const RETRY_KEY = 'clientRequestId';
const RETRY_KEY_SCHEMA = { type: 'string', description: 'Optional retry key. Retrying this same call after a lost response? Pass the same value to get the original result instead of running it again.' };
const RETRY_KEYS_KEPT = 500;
const REPLAY_NOTE = 'Result of the earlier call with this clientRequestId; the tool was not run again.';

/** A tool whose call may change something, so a retry of it needs a key. */
function retryable(tool: ToolHandler): boolean {
  if (tool.replaySafety === 'read_only') return false;
  return !(typeof tool.permissionAction === 'string' && ['read', 'list', 'search', 'inspect'].includes(tool.permissionAction));
}

/** The tool's schema with the optional retry key, for a tool that changes something. */
function advertisedSchema(tool: ToolHandler): Record<string, unknown> {
  const schema = tool.parameters as { type?: unknown; properties?: Record<string, unknown> };
  if (!retryable(tool) || schema?.type !== 'object' || schema.properties?.[RETRY_KEY]) return tool.parameters;
  return { ...schema, properties: { ...schema.properties, [RETRY_KEY]: RETRY_KEY_SCHEMA } };
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
  /** The names `GET /tools` lists right now. */
  toolNames: () => string[];
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
  // Calls made with a retry key, by tool and key: a retry is answered from here.
  const keyed = new Map<string, { operation: Promise<BridgeResult>; fingerprint: string; started: () => boolean }>();
  const isUnqueued = (name: string) => options.unqueued?.has(name) || ['get_pipeline_status', 'monitor__list', 'monitor__create', 'answer_pipeline_approval'].includes(name);
  const listTools = () => {
    const tools = (options.advertisedTools?.() ?? options.tools()).map(t => ({ name: t.name, description: t.description,
      inputSchema: isUnqueued(t.name) ? t.parameters : advertisedSchema(t) }));
    if (options.advertisedTools && options.tools().length) tools.push({ name: 'call_discovered_tool',
      description: 'Call an Octipus tool discovered through list_tools/describe_tool using its exact name and arguments.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] } });
    return tools;
  };
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value), () => options.delivered?.());
    };
    const socket = req.socket;
    let expired = false;
    let started = false;
    let joined = false;
    let settled = false;
    let toolName: string | undefined;
    const onClose = () => {
      if (!res.writableEnded && started && !settled && toolName && !isUnqueued(toolName)) options.abandoned?.(toolName);
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
        reply(200, { tools: listTools() });
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
          if (started && !settled && !isUnqueued(input.name)) options.abandoned?.(input.name);
          // A retry that joined an earlier keyed call never starts itself, but
          // the earlier call may well have run: only an unjoined, unstarted
          // call is known not to have executed.
          const outcome = started || joined
            ? 'Execution may have started; inspect its outcome before retrying.'
            : 'The queued call was not executed.';
          expire(new BridgeError(`Tool ${input.name} timed out after ${ms}ms. ${outcome}`));
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
        if (!isUnqueued(input.name)) approvalCall = approval;
        if (options.longWait?.has(input.name)) clearTimeout(deadline);
        else arm(executionBudget);
        try { return await options.execute(input.name, input.arguments); }
        finally { settled = true; if (approvalCall === approval) approvalCall = undefined; }
      };
      // ponytail: one queue per worker; unqueued read-only tools keep context reads
      // responsive while an awaited delegation holds the queue. Parallel executor
      // calls if ToolExecutor's counters/final-flag are ever made concurrency-safe.
      let operation: Promise<BridgeResult>;
      const handler = options.tools().find(t => t.name === input.name);
      const rawKey = input.arguments[RETRY_KEY];
      const clientRequestId = typeof rawKey === 'string' ? rawKey.trim() : '';
      // The tool's own schema may take the key (create_pipeline keeps it across turns); otherwise it is the bridge's alone.
      if (rawKey !== undefined && handler && !(handler.parameters as { properties?: Record<string, unknown> })?.properties?.[RETRY_KEY]) {
        delete input.arguments[RETRY_KEY];
      }
      // An empty key is no key: distinct calls must not share one.
      const requestKey = clientRequestId && handler && retryable(handler) && !isUnqueued(input.name)
        ? `${input.name}\u0000${clientRequestId}` : undefined;
      const fingerprint = requestKey
        ? canonical(Object.fromEntries(Object.entries(input.arguments).filter(([name]) => name !== RETRY_KEY))) : '';
      const earlier = requestKey ? keyed.get(requestKey) : undefined;
      if (earlier && earlier.fingerprint !== fingerprint) {
        throw new BridgeError(`clientRequestId "${clientRequestId}" was already used for a different ${input.name} call in this run. Use a new clientRequestId for new work.`,
          'CLIENT_REQUEST_ID_REUSED', false);
      }
      const enqueue = () => {
        queueBounded = mine;
        const queued = queue.then(run); queue = queued.then(() => undefined, () => undefined);
        return queued;
      };
      const remember = (call: Promise<BridgeResult>) => {
        if (!requestKey) return;
        const entry = { operation: call, fingerprint, started: () => started };
        keyed.set(requestKey, entry);
        // A call that did not run, or failed, may be retried for real.
        const forget = () => { if (keyed.get(requestKey) === entry) keyed.delete(requestKey); };
        call.then(result => { if (result.isError) forget(); }, forget);
        while (keyed.size > RETRY_KEYS_KEPT) keyed.delete(keyed.keys().next().value as string);
      };
      // A joining retry has no queue wait of its own; it is bounded by the execution clock armed below.
      const ahead = isUnqueued(input.name) ? Promise.resolve() : earlier ? new Promise<void>(() => {}) : queueBounded;
      if (earlier) {
        joined = true;
        // Wait on the first call within this request's own deadline.
        arm(executionBudget);
        operation = earlier.operation.then(
          result => ({ ...result, content: [{ type: 'text' as const, text: REPLAY_NOTE }, ...result.content] }),
          err => {
            // The first call was dropped before it ran (its caller left while
            // it queued): nothing happened, so this request runs it itself
            // rather than inheriting that cancellation.
            if (earlier.started() || expired || res.destroyed) throw err;
            const own = enqueue();
            remember(own);
            return own;
          });
      } else if (isUnqueued(input.name)) operation = run();
      else operation = enqueue();
      if (requestKey && !earlier) remember(operation);
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
    toolNames: () => listTools().map(tool => tool.name),
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
