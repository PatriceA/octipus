/**
 * A minimal POP3 client (RFC 1939, STLS from RFC 2595): enough to list a
 * maildrop by UIDL, read headers with TOP and fetch messages with RETR.
 * Nothing is deleted on the server. Used for drops such as the KIM client
 * module, which speaks POP3 and SMTP only.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { MailSecurity } from '@/shared/mail';

export interface Pop3Options {
  /** The address to connect to (pinned, see hosts.ts). */
  address: string;
  port: number;
  /** The name to check the certificate against. */
  servername?: string;
  security: MailSecurity;
  username: string;
  password: string;
  timeoutMs?: number;
  /** The largest response accepted; a bigger message fails the command. */
  maxResponseBytes?: number;
}

export class Pop3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Pop3Error';
  }
}

const CRLF = Buffer.from('\r\n');
const TERMINATOR = Buffer.from('\r\n.\r\n');

interface Waiter {
  multi: boolean;
  resolve: (value: { status: string; body: Buffer }) => void;
  reject: (err: Error) => void;
}

/** Undo dot-stuffing of a multi-line body (RFC 1939 §3). */
function unstuff(body: Buffer): Buffer {
  const text = body.toString('latin1');
  return Buffer.from(text.replace(/(^|\r\n)\.\./g, '$1.'), 'latin1');
}

export class Pop3Client {
  private socket: net.Socket;
  private buf = Buffer.alloc(0);
  private waiter: Waiter | null = null;
  private failure: Error | null = null;
  private readonly maxBytes: number;

  private constructor(socket: net.Socket, private readonly opts: Pop3Options) {
    this.socket = socket;
    this.maxBytes = opts.maxResponseBytes ?? 30 * 1024 * 1024;
    this.attach(socket);
  }

  /** Connect, upgrade with STLS when asked, and log in. */
  static async connect(opts: Pop3Options): Promise<Pop3Client> {
    const timeout = opts.timeoutMs ?? 30_000;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = opts.security === 'tls'
        ? tls.connect({ host: opts.address, port: opts.port, servername: opts.servername, timeout })
        : net.connect({ host: opts.address, port: opts.port, timeout });
      const ready = opts.security === 'tls' ? 'secureConnect' : 'connect';
      s.once(ready, () => resolve(s));
      s.once('error', reject);
      s.once('timeout', () => { s.destroy(); reject(new Pop3Error('Connection timed out')); });
    });
    socket.setTimeout(timeout);
    const client = new Pop3Client(socket, opts);
    // The whole greeting, STLS and login must finish in time: idle timeouts
    // alone let a server that trickles bytes hold the connection forever.
    const deadline = setTimeout(() => {
      client.fail(new Pop3Error('The server took too long to log in'));
      client.destroy();
    }, timeout * 2);
    deadline.unref?.();
    try {
      await client.expectOk(client.read(false));
      if (opts.security === 'starttls') await client.startTls();
      await client.command(`USER ${opts.username}`);
      await client.command(`PASS ${opts.password}`).catch((err) => {
        throw err instanceof Pop3Error && err.message.startsWith('The server answered') ? new Pop3Error('The server refused the login') : err;
      });
      return client;
    } catch (err) {
      client.destroy();
      throw err;
    } finally {
      clearTimeout(deadline);
    }
  }

  private attach(socket: net.Socket): void {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('timeout', () => { this.fail(new Pop3Error('The server stopped answering')); socket.destroy(); });
    socket.on('close', () => this.fail(new Pop3Error('The connection closed')));
  }

  private detach(socket: net.Socket): void {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('timeout');
    socket.removeAllListeners('close');
  }

  fail(err: Error): void {
    this.failure ??= err;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(this.failure);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.maxBytes) {
      this.fail(new Pop3Error('The message is too large'));
      this.socket.destroy();
      return;
    }
    this.drain();
  }

  /** Complete the waiting command once its whole response is in. */
  private drain(): void {
    const w = this.waiter;
    if (!w) return;
    const lineEnd = this.buf.indexOf(CRLF);
    if (lineEnd < 0) return;
    const status = this.buf.subarray(0, lineEnd).toString('utf8');
    if (!w.multi || !status.startsWith('+OK')) {
      this.buf = this.buf.subarray(lineEnd + 2);
      this.waiter = null;
      w.resolve({ status, body: Buffer.alloc(0) });
      return;
    }
    const end = this.buf.indexOf(TERMINATOR, lineEnd);
    if (end < 0) return;
    const body = end === lineEnd ? Buffer.alloc(0) : this.buf.subarray(lineEnd + 2, end + 2);
    this.buf = this.buf.subarray(end + TERMINATOR.length);
    this.waiter = null;
    w.resolve({ status, body: unstuff(body) });
  }

  private read(multi: boolean): Promise<{ status: string; body: Buffer }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { multi, resolve, reject };
      this.drain();
    });
  }

  private async expectOk(pending: Promise<{ status: string; body: Buffer }>): Promise<{ status: string; body: Buffer }> {
    const res = await pending;
    if (!res.status.startsWith('+OK')) throw new Pop3Error(`The server answered: ${res.status.slice(0, 200)}`);
    return res;
  }

  private async command(line: string, multi = false): Promise<{ status: string; body: Buffer }> {
    if (/[\r\n]/.test(line)) throw new Pop3Error('A POP3 command cannot contain a line break');
    const pending = this.read(multi);
    this.socket.write(`${line}\r\n`);
    return this.expectOk(pending);
  }

  private async startTls(): Promise<void> {
    await this.command('STLS');
    const plain = this.socket;
    this.detach(plain);
    plain.on('error', () => undefined);
    const timeout = this.opts.timeoutMs ?? 30_000;
    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: this.opts.servername });
      // Until the handshake is done, its failure or silence ends both sockets.
      const fail = (err: Error) => {
        s.removeAllListeners();
        s.on('error', () => undefined);
        s.destroy();
        plain.destroy();
        reject(err);
      };
      s.setTimeout(timeout, () => fail(new Pop3Error('The TLS handshake timed out')));
      s.once('error', fail);
      s.once('secureConnect', () => {
        s.removeAllListeners('error');
        s.removeAllListeners('timeout');
        s.setTimeout(0);
        resolve(s);
      });
    });
    this.socket.setTimeout(timeout);
    this.buf = Buffer.alloc(0);
    this.attach(this.socket);
  }

  /** Every message's number and unique id. */
  async uidl(): Promise<Array<{ num: number; uid: string }>> {
    const { body } = await this.command('UIDL', true);
    return body.toString('latin1').split('\r\n').filter(Boolean).map((line) => {
      const [num, uid] = line.trim().split(/\s+/, 2);
      return { num: Number(num), uid };
    }).filter((m) => Number.isInteger(m.num) && m.num > 0 && !!m.uid);
  }

  /** Every message's number and size in bytes. */
  async list(): Promise<Map<number, number>> {
    const { body } = await this.command('LIST', true);
    const sizes = new Map<number, number>();
    for (const line of body.toString('latin1').split('\r\n')) {
      const [num, size] = line.trim().split(/\s+/, 2).map(Number);
      if (Number.isInteger(num) && num > 0) sizes.set(num, size);
    }
    return sizes;
  }

  /** A message's headers (and `lines` lines of its body). */
  async top(num: number, lines = 0): Promise<Buffer> {
    return (await this.command(`TOP ${num} ${lines}`, true)).body;
  }

  /** A whole message. */
  async retr(num: number): Promise<Buffer> {
    return (await this.command(`RETR ${num}`, true)).body;
  }

  /** End the session politely; never deletes (no DELE was sent). */
  async quit(): Promise<void> {
    try {
      await this.command('QUIT');
    } catch { /* closing anyway */ }
    this.destroy();
  }

  destroy(): void {
    this.detach(this.socket);
    this.socket.on('error', () => undefined);
    this.socket.destroy();
  }
}
