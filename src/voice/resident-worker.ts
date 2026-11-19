/**
 * A helper process that stays up between requests, speaking JSON lines over
 * stdio: one request line in, one reply line out, one at a time. For local
 * speech engines whose cost is loading the model (Kokoro): started on the
 * first request, kept while it is used, stopped after ten idle minutes, and
 * replaced when it dies.
 */
import { type ChildProcessHandle as Subprocess, spawnProcess as spawn } from '@/utils/proc';
import { AsyncLineReader } from './stt';

const IDLE_MS = 10 * 60_000;

export class ResidentWorker {
  private proc: Subprocess<'pipe', 'pipe', 'inherit'> | null = null;
  private sink: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private lines: AsyncLineReader | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly name: string, private readonly command: string, private readonly args: string[]) {}

  private async ensure(): Promise<void> {
    if (this.proc) return;
    const proc = spawn({ command: this.command, args: this.args, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
    this.proc = proc;
    this.sink = proc.stdin!.getWriter();
    this.lines = new AsyncLineReader(proc.stdout as ReadableStream<Uint8Array>);
    const first = await this.lines.next();
    let ready: { ready?: boolean; error?: string } = {};
    try { ready = first ? JSON.parse(first) as typeof ready : {}; } catch { /* not JSON: reported below */ }
    if (!ready.ready) {
      await this.stop();
      throw new Error(`${this.name} worker failed to start${ready.error ? `: ${ready.error}` : first ? `: ${first.slice(0, 200)}` : ' (is `uv` installed?)'}`);
    }
  }

  /** Send one request and await its reply. A reply with `error` throws. */
  request<T extends object>(body: object): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.idle) { clearTimeout(this.idle); this.idle = null; }
      try {
        await this.ensure();
        await this.sink!.write(new TextEncoder().encode(`${JSON.stringify(body)}\n`));
        const line = await this.lines!.next();
        if (line == null) throw new Error(`${this.name} worker closed unexpectedly`);
        const reply = JSON.parse(line) as T & { error?: string };
        if (reply.error) throw new WorkerReplyError(`${this.name}: ${reply.error}`);
        return reply;
      } catch (err) {
        // A refused request leaves the worker healthy; anything else means it is gone.
        if (!(err instanceof WorkerReplyError)) await this.stop();
        throw err;
      } finally {
        this.idle = setTimeout(() => { void this.stop(); }, IDLE_MS);
        this.idle.unref?.();
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async stop(): Promise<void> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    try { void this.sink?.close(); } catch { /* already closed */ }
    this.sink = null;
    this.lines = null;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

class WorkerReplyError extends Error {}
