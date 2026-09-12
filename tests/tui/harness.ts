/** Runs the shipped Node entry in a real PTY and parses the CURRENT terminal screen. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocketServer, type WebSocket } from 'ws';
import xterm from '@xterm/headless';
const { Terminal } = xterm;

export class TuiHarness {
  readonly home = mkdtempSync(join(tmpdir(), 'tui-screen-'));
  readonly project = join(this.home, 'project');
  readonly screen: InstanceType<typeof Terminal>;
  readonly commands: any[] = [];
  readonly server: WebSocketServer;
  readonly proc: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  private sockets = new Set<WebSocket>();
  private writes: Promise<void> = Promise.resolve();
  private error = '';
  private stopped = false;

  private constructor(entry: string, server: WebSocketServer, cols: number, rows: number) {
    this.server = server;
    mkdirSync(this.project);
    writeFileSync(join(this.project, 'example.ts'), 'const greeting = "hello";\n' + 'x'.repeat(120) + '\n');
    this.screen = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 });
    const port = (server.address() as { port: number }).port;
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('message', raw => {
        const msg = JSON.parse(String(raw)); this.commands.push(msg);
        if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
        if (msg.type === 'command') {
          const result = msg.name === 'work-plan-status' ? '1/3 steps done · Check rendering'
            : msg.name === 'work-plan' ? 'Plan: Improve the terminal\n[done] Inspect\n[active] Check rendering\n[pending] Verify'
            : msg.name === 'plan-feedback' ? 'Feedback saved as pending.' : 'Available: /help /work-plan /plan-feedback';
          socket.send(JSON.stringify({ type: 'command.result', name: msg.name, result }));
        }
        if (msg.type === 'chat.send') {
          this.event('chat.delta', { delta: 'A streaming reply', iteration: 1 }, msg.sessionId);
        }
      });
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.proc = spawn('python3', [resolve('tests/tui/pty.py'), String(cols), String(rows), process.execPath,
      '--import', 'tsx', '--import', './scripts/md-loader.mjs', entry, '--project', this.project], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: this.home, API_PORT: String(port), TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: undefined },
    });
    createInterface({ input: this.proc.stdout }).on('line', line => {
      const message = JSON.parse(line);
      if (message.data) {
        const data = Buffer.from(message.data, 'base64');
        this.writes = this.writes.then(() => new Promise<void>(resolve => this.screen.write(data, resolve)));
      }
    });
    this.proc.stderr.on('data', data => { this.error += data; });
    this.exited = new Promise(resolve => this.proc.once('exit', resolve));
  }
  static async start(entry: string, cols = 100, rows = 28): Promise<TuiHarness> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    return new TuiHarness(entry, server, cols, rows);
  }
  send(input: string): void { this.proc.stdin.write(JSON.stringify({ input }) + '\n'); }
  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows); this.proc.stdin.write(JSON.stringify({ resize: [cols, rows] }) + '\n');
  }
  event(type: string, payload: unknown, sessionId?: string): void {
    for (const socket of this.sockets) socket.send(JSON.stringify({ type: 'event', event: { type, payload, sessionId } }));
  }
  async text(): Promise<string> {
    await this.writes;
    const b = this.screen.buffer.active;
    return Array.from({ length: this.screen.rows }, (_, row) => b.getLine(b.viewportY + row)?.translateToString(true) ?? '').join('\n');
  }
  async waitFor(needle: string, absent = false): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const text = await this.text();
      if (text.includes(needle) !== absent) return;
      if (this.proc.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Screen did not ${absent ? 'remove' : 'show'} ${JSON.stringify(needle)}:\n${await this.text()}\n${this.error}`);
  }
  async saveScreen(name: string): Promise<void> {
    const dir = process.env.TUI_SCREENSHOTS_DIR;
    if (!dir) return;
    await this.writes; mkdirSync(dir, { recursive: true });
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rgb = (n: number) => '#' + n.toString(16).padStart(6, '0');
    const b = this.screen.buffer.active;
    const rows = Array.from({ length: this.screen.rows }, (_, row) => {
      const line = b.getLine(b.viewportY + row);
      let html = '';
      for (let col = 0; col < this.screen.cols; col++) {
        const cell = line?.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        const fg = cell.isFgRGB() ? rgb(cell.getFgColor()) : '#edf5f3';
        const bg = cell.isBgRGB() ? rgb(cell.getBgColor()) : 'transparent';
        html += `<span style="color:${fg};background:${bg};font-weight:${cell.isBold() ? 'bold' : 'normal'}">${escape(cell.getChars() || ' ')}</span>`;
      }
      return html;
    });
    writeFileSync(join(dir, `${name}.html`), `<!doctype html><meta charset="utf-8"><title>${escape(name)}</title><style>body{margin:24px;background:#071923;color:#edf5f3}pre{font:14px/20px "DejaVu Sans Mono",monospace;padding:20px;border:1px solid #34515b;border-radius:8px;width:max-content}</style><pre>${rows.join('\n')}</pre>`);
    writeFileSync(join(dir, `${name}.txt`), await this.text());
  }

  async stop(): Promise<void> {
    if (this.stopped) return; this.stopped = true;
    if (this.proc.exitCode === null) this.proc.stdin.write('{"stop":true}\n');
    const kill = setTimeout(() => { if (this.proc.exitCode === null) this.proc.stdin.write('{"kill":true}\n'); }, 2000);
    const relayKill = setTimeout(() => this.proc.kill('SIGKILL'), 4000);
    try { await this.exited; } finally { clearTimeout(kill); clearTimeout(relayKill); }
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.screen.dispose(); rmSync(this.home, { recursive: true, force: true });
  }
}
export const KEY = { Enter: '\r', Esc: '\x1b', CtrlO: '\x0f', CtrlP: '\x10', CtrlQ: '\x11', CtrlW: '\x17', CtrlBackslash: '\x1c', PageUp: '\x1b[5~', End: '\x1b[F' };
