/** Runs the shipped Node entry in a real PTY and parses the CURRENT terminal screen. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import xterm from '@xterm/headless';
const { Terminal } = xterm;

export interface HarnessOptions {
  /** Extra environment for the program (a fake clipboard tool on PATH, a DISPLAY). */
  env?: Record<string, string | undefined>;
  /** Written to the screen before the program starts: what the user had in the terminal before launch. */
  preamble?: string;
  /** Files written under the test HOME before launch, by path relative to it (`.octipus/tui.json`). */
  files?: Record<string, string>;
  /** Run the program under another one (`tmux new-session --`): its argv goes in front of the Node command. */
  wrap?: string[];
  /** What the fixture gateway answers to a command, by name, instead of its default text. */
  commandResults?: Record<string, { result: unknown; data?: unknown; error?: string }>;
  /** The Python that runs `pty.py`. Default: `TUI_PTY_PYTHON`, else `python3`. */
  python?: string;
  /**
   * What the fixture's REST API (`/api/...`, the same port as the gateway)
   * answers to a GET, by path and query; undefined answers 404. Every
   * request is recorded in `requests`.
   */
  http?: (path: string) => { status?: number; body: unknown } | undefined;
}

const probed = new Map<string, string | null>();

/**
 * Why this machine cannot run the PTY relay, or null when it can.
 *
 * The relay is `pty.py`: Python's standard library `pty`, `termios` and
 * `fcntl`, which exist on Linux and macOS only. Without this check a missing
 * `python3` surfaced as an unhandled spawn error in the test worker, and a
 * Python without `os.forkpty` (Windows) as an 8-second wait for a screen that
 * never came. The product itself needs no Python: only these suites do.
 */
export function ptyRelayProblem(python: string, platform: NodeJS.Platform = process.platform): string | null {
  const key = `${platform}\0${python}`;
  const known = probed.get(key);
  if (known !== undefined) return known;
  let problem: string | null = null;
  if (platform === 'win32') {
    problem = 'The terminal suites drive the program through tests/tui/pty.py, which needs a POSIX pseudo-terminal '
      + '(Python\'s pty, termios and fcntl). Windows has none: run `npm run test:tui` under WSL, Linux or macOS.';
  } else {
    const probe = spawnSync(python, ['-c', 'import fcntl, os, pty, termios; os.forkpty'], { encoding: 'utf8', timeout: 10_000 });
    if (probe.error) {
      const code = (probe.error as NodeJS.ErrnoException).code;
      problem = code === 'ENOENT'
        ? `The terminal suites need Python 3 for their PTY relay (tests/tui/pty.py), and \`${python}\` is not on PATH. Install python3 or set TUI_PTY_PYTHON.`
        : `The PTY relay's Python (\`${python}\`) could not be run: ${probe.error.message}`;
    } else if (probe.status !== 0) {
      problem = `\`${python}\` cannot run the PTY relay (tests/tui/pty.py needs fcntl, os.forkpty, pty and termios): ${probe.stderr.trim() || `exit ${probe.status}`}`;
    }
  }
  probed.set(key, problem);
  return problem;
}

export class TuiHarness {
  readonly home = mkdtempSync(join(tmpdir(), 'tui-screen-'));
  readonly project = join(this.home, 'project');
  readonly screen: InstanceType<typeof Terminal>;
  readonly commands: any[] = [];
  readonly clipboardRequests: string[] = [];
  /** Every byte the program wrote, in order: modes and cursor visibility that the screen model does not expose. */
  readonly output: Buffer[] = [];
  readonly server: WebSocketServer;
  /** The fixture's HTTP server: the gateway's upgrade and the REST API. */
  readonly httpServer: Server;
  /** REST requests the program made: method, path with query, and its Authorization header. */
  readonly requests: Array<{ method: string; path: string; authorization?: string }> = [];
  readonly proc: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  private sockets = new Set<WebSocket>();
  private writes: Promise<void> = Promise.resolve();
  private error = '';
  private stopped = false;
  /** The `turnId` of the latest `chat.send`: the fixture gateway answers it, as the real one echoes it. */
  private lastTurnId: string | undefined;

  private constructor(entry: string, httpServer: Server, server: WebSocketServer, cols: number, rows: number, args: string[], options: HarnessOptions, python: string) {
    this.server = server;
    this.httpServer = httpServer;
    httpServer.on('request', (req, res) => {
      const path = req.url ?? '/';
      this.requests.push({ method: req.method ?? 'GET', path, authorization: req.headers.authorization });
      const answer = req.method === 'GET' && path.startsWith('/api/') ? options.http?.(path.slice('/api'.length)) : undefined;
      res.writeHead(answer?.status ?? (answer ? 200 : 404), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer ? answer.body : { error: 'Not found' }));
    });
    mkdirSync(this.project);
    // The TUI signs in with the stored CLI login and nothing else; without
    // one it opens the login prompt instead of connecting.
    mkdirSync(join(this.home, '.octipus'));
    writeFileSync(join(this.home, '.octipus', 'session.json'), JSON.stringify({
      token: 'test-session-token', userId: '11111111-1111-4111-8111-111111111111', username: 'tester', isAdmin: false,
    }));
    for (const [path, content] of Object.entries(options.files ?? {})) writeFileSync(join(this.home, path), content);
    writeFileSync(join(this.project, 'example.ts'), 'const greeting = "hello";\n' + 'x'.repeat(120) + '\n');
    this.screen = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 });
    this.screen.parser.registerOscHandler(52, data => { this.clipboardRequests.push(data); return true; });
    const preamble = options.preamble;
    if (preamble) this.writes = new Promise<void>(resolve => this.screen.write(preamble.replace(/\n/g, '\r\n'), resolve));
    const port = (httpServer.address() as { port: number }).port;
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('message', raw => {
        const msg = JSON.parse(String(raw)); this.commands.push(msg);
        if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
        if (msg.type === 'command' && options.commandResults?.[msg.name]) {
          socket.send(JSON.stringify({ type: 'command.result', name: msg.name, ...options.commandResults[msg.name] }));
        } else if (msg.type === 'command') {
          const result = msg.name === 'work-plan-status' ? '1/3 steps done · Check rendering'
            : msg.name === 'work-plan' ? 'Plan: Improve the terminal\n[done] Inspect\n[active] Check rendering\n[pending] Verify'
            : msg.name === 'plan-feedback' ? 'Feedback saved as pending.' : 'Available: /help /work-plan /plan-feedback';
          socket.send(JSON.stringify({ type: 'command.result', name: msg.name, result }));
        }
        if (msg.type === 'chat.send') {
          this.lastTurnId = typeof msg.turnId === 'string' ? msg.turnId : undefined;
          this.event('chat.delta', { delta: 'A streaming reply', iteration: 1 }, msg.sessionId);
        }
      });
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.proc = spawn(python, [resolve('tests/tui/pty.py'), String(cols), String(rows), ...(options.wrap ?? []), process.execPath,
      '--import', 'tsx', '--import', './scripts/md-loader.mjs', entry, '--project', this.project, ...args], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
      // No display, multiplexer or SSH session from the machine running the tests: the
      // clipboard chain would otherwise reach the developer's real clipboard.
      env: {
        ...process.env, HOME: this.home, API_PORT: String(port), TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: undefined,
        DISPLAY: undefined, WAYLAND_DISPLAY: undefined, TMUX: undefined, SSH_CONNECTION: undefined, SSH_TTY: undefined, WSL_DISTRO_NAME: undefined,
        ...options.env,
      },
    });
    createInterface({ input: this.proc.stdout }).on('line', line => {
      let message: { data?: string };
      try { message = JSON.parse(line); } catch {
        this.error += `PTY relay wrote a line that is not JSON: ${line}\n`;
        return;
      }
      if (message.data) {
        const data = Buffer.from(message.data, 'base64');
        this.output.push(data);
        this.writes = this.writes.then(() => new Promise<void>(resolve => this.screen.write(data, resolve)));
      }
    });
    this.proc.stderr.on('data', data => { this.error += data; });
    this.exited = new Promise(resolve => {
      this.proc.once('exit', resolve);
      // Not left unhandled: an 'error' with no listener kills the test worker instead of failing the test.
      this.proc.once('error', error => { this.error += `PTY relay failed: ${error.message}\n`; resolve(null); });
    });
  }
  static async start(entry: string, cols = 100, rows = 28, args: string[] = [], options: HarnessOptions = {}): Promise<TuiHarness> {
    const python = options.python ?? process.env.TUI_PTY_PYTHON ?? 'python3';
    const problem = ptyRelayProblem(python);
    if (problem) throw new Error(problem);
    const httpServer = createServer();
    const server = new WebSocketServer({ server: httpServer });
    await new Promise<void>((resolve, reject) => { httpServer.once('listening', resolve); httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1'); });
    return new TuiHarness(entry, httpServer, server, cols, rows, args, options, python);
  }
  /** The terminal's normal buffer — scrollback and screen — as text, whichever buffer is showing. */
  async normalBuffer(): Promise<string> {
    await this.writes;
    const b = this.screen.buffer.normal;
    return Array.from({ length: b.length }, (_, row) => b.getLine(row)?.translateToString(true) ?? '').join('\n');
  }
  /** Which buffer the terminal is showing. */
  async bufferType(): Promise<'normal' | 'alternate'> { await this.writes; return this.screen.buffer.active.type; }
  send(input: string): void { this.proc.stdin.write(JSON.stringify({ input }) + '\n'); }
  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows); this.proc.stdin.write(JSON.stringify({ resize: [cols, rows] }) + '\n');
  }
  /**
   * Send an event. A `chat.response` / `chat.error` that names no `turnId`
   * answers the latest `chat.send`, as the real gateway's reply to it does
   * (message-handler.ts echoes the send's `turnId`); pass one to say otherwise.
   */
  event(type: string, payload: unknown, sessionId?: string): void {
    if ((type === 'chat.response' || type === 'chat.error') && this.lastTurnId && payload && typeof payload === 'object' && !('turnId' in payload)) {
      payload = { ...payload, turnId: this.lastTurnId };
    }
    for (const socket of this.sockets) socket.send(JSON.stringify({ type: 'event', event: { type, payload, sessionId } }));
  }
  /** Send a raw server frame (an `error`, `events_dropped`, …). */
  frame(frame: Record<string, unknown>): void {
    for (const socket of this.sockets) socket.send(JSON.stringify(frame));
  }
  /** The `turnId` of the latest `chat.send`, which a reply that names none answers. */
  latestTurnId(): string | undefined { return this.lastTurnId; }
  /** Drop every connection as a crashed server would (no close frame): the client reconnects with backoff. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }
  async text(): Promise<string> {
    await this.writes;
    const b = this.screen.buffer.active;
    return Array.from({ length: this.screen.rows }, (_, row) => b.getLine(b.viewportY + row)?.translateToString(true) ?? '').join('\n');
  }
  /** What the program wrote to stderr (the error an exit printed). */
  stderr(): string { return this.error; }
  /** Everything written so far, decoded; wait for `text()` first so it is complete up to the screen. */
  rawOutput(): string { return Buffer.concat(this.output).toString('utf8'); }
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
  /**
   * Connected, and the plan this fixture's server answers with is drawn.
   *
   * Until then the status area is still growing: "authenticating" with a
   * two-row plan placeholder, then the full plan. In the editor that area is
   * at the top, so every pane moves down when the plan lands, and a click
   * aimed at coordinates read before that hits the row above its target —
   * which is how `editor-mouse.e2e`'s tree click failed about one run in
   * ten on a loaded machine. Read screen coordinates after this.
   */
  async ready(): Promise<void> {
    await this.waitFor('connected');
    await this.waitFor('[pending] Verify');
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
    this.httpServer.closeAllConnections();
    await new Promise<void>(resolve => this.httpServer.close(() => resolve()));
    this.screen.dispose(); rmSync(this.home, { recursive: true, force: true });
  }
}
export const KEY = { Enter: '\r', Esc: '\x1b', CtrlO: '\x0f', CtrlP: '\x10', CtrlQ: '\x11', CtrlW: '\x17', CtrlBackslash: '\x1c', PageUp: '\x1b[5~', End: '\x1b[F' };
