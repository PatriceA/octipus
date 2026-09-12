"""Small POSIX PTY relay. Python stdlib only; Node owns assertions and VT parsing."""
import base64
import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios

cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, master = os.forkpty()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.execvp(sys.argv[3], sys.argv[3:])

pending = b''
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            print(json.dumps({'data': base64.b64encode(data).decode()}), flush=True)
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                os.kill(pid, signal.SIGTERM)
                break
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try:
                    command = json.loads(line)
                except ValueError:
                    continue  # a bad line must not kill the relay and orphan the child
                if 'input' in command:
                    os.write(master, command['input'].encode())
                elif 'resize' in command:
                    cols, rows = command['resize']
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                    os.kill(pid, signal.SIGWINCH)
                elif 'stop' in command:
                    os.kill(pid, signal.SIGTERM)
                elif 'kill' in command:
                    os.kill(pid, signal.SIGKILL)
finally:
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    exit_code = code if code >= 0 else 128 - code  # POSIX 128+signal, same value in JSON and process exit
    print(json.dumps({'exit': exit_code}), flush=True)
    os.close(master)

sys.exit(exit_code)
