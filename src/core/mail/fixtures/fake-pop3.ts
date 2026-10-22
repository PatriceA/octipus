/**
 * A POP3 server for tests: plain TCP on 127.0.0.1, one maildrop, the
 * commands the client uses (USER, PASS, STAT, UIDL, LIST, TOP, RETR, QUIT).
 * Counts RETR calls so a test can see what was fetched; never deletes.
 */
import net from 'node:net';

export interface FakeMessage {
  uid: string;
  raw: string;
}

export interface FakePop3 {
  port: number;
  messages: FakeMessage[];
  retrieved: string[];
  close(): Promise<void>;
}

/** Dot-stuff and terminate a multi-line body. */
function multiline(body: string): string {
  const lines = body.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l));
  return `${lines.join('\r\n')}\r\n.\r\n`;
}

export async function startFakePop3(opts: { user: string; pass: string; messages: FakeMessage[]; stallOnStls?: boolean }): Promise<FakePop3> {
  const state: FakePop3 = { port: 0, messages: opts.messages, retrieved: [], close: async () => undefined };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let user = '';
    let authed = false;
    let pending = '';
    socket.write('+OK fake POP3 ready\r\n');
    socket.on('data', (chunk) => {
      pending += chunk.toString('latin1');
      let idx: number;
      while ((idx = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        const [cmd, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        const msgs = state.messages;
        const byNum = (n: string) => msgs[Number(n) - 1];
        switch (cmd.toUpperCase()) {
          case 'USER': user = arg; socket.write('+OK\r\n'); break;
          case 'PASS':
            if (user === opts.user && arg === opts.pass) { authed = true; socket.write('+OK logged in\r\n'); }
            else socket.write('-ERR invalid login\r\n');
            break;
          case 'QUIT': socket.end('+OK bye\r\n'); break;
          // Agree to STLS, then never start the handshake.
          case 'STLS': if (opts.stallOnStls) socket.write('+OK begin TLS\r\n'); else socket.write('-ERR not supported\r\n'); break;
          default:
            if (!authed) { socket.write('-ERR not logged in\r\n'); break; }
            if (cmd === 'STAT') socket.write(`+OK ${msgs.length} 0\r\n`);
            else if (cmd === 'UIDL') socket.write(`+OK\r\n${multiline(msgs.map((m, i) => `${i + 1} ${m.uid}`).join('\r\n')).replace(/^\r\n/, '')}`);
            else if (cmd === 'LIST') socket.write(`+OK\r\n${multiline(msgs.map((m, i) => `${i + 1} ${Buffer.byteLength(m.raw)}`).join('\r\n'))}`);
            else if (cmd === 'TOP') {
              const m = byNum(rest[0]);
              if (!m) socket.write('-ERR no such message\r\n');
              else socket.write(`+OK\r\n${multiline(m.raw.split(/\r?\n\r?\n/)[0])}`);
            } else if (cmd === 'RETR') {
              const m = byNum(arg);
              if (!m) socket.write('-ERR no such message\r\n');
              else { state.retrieved.push(m.uid); socket.write(`+OK\r\n${multiline(m.raw)}`); }
            } else socket.write('-ERR unknown command\r\n');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
  return state;
}
