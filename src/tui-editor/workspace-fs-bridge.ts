/**
 * Bridge between the TUI editor and the local filesystem.
 *
 * The editor uses `node:fs` synchronously for read / write — the
 * TUI runs locally on the user's machine and the file sizes
 * involved (single-file open) don't justify async indirection.
 *
 * Errors are swallowed at the bridge boundary and surfaced as
 * `null`. Callers (file tree, save command) decide whether to
 * raise a notification.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB safety cap per buffer

export function readFileForBuffer(absPath: string): string | null {
  try {
    const buf = readFileSync(absPath);
    if (buf.byteLength > MAX_BYTES) return null;
    // Reject obvious binary files by sniffing for a NUL.
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

export function writeFileForBuffer(absPath: string, text: string): boolean {
  try {
    writeFileSync(absPath, text, 'utf8');
    return true;
  } catch {
    return false;
  }
}
